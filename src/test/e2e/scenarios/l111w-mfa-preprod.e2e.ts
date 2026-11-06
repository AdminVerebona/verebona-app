/**
 * Lot 111W — MFA / clés d'accès en préproduction. PostgreSQL 16 réel, VRAIES
 * routes (aucun mock des validations WebAuthn).
 *
 *   L111W-BO    BO : environnement APPLICATIF (NEXT_PUBLIC_APP_ENV) distinct de
 *               NODE_ENV, « Inconnu / configuration à vérifier » sinon (jamais
 *               « production » par défaut), cohérence RP ID / origines, aucun secret ;
 *   L111W-PUB   statut global anonyme `passkey` (GET /api/auth/oauth/providers) :
 *               identique avec ou sans session, aucune donnée de compte ;
 *   L111W-503   configuration WebAuthn invalide : 503 MFA_METHOD_UNAVAILABLE au
 *               message NEUTRE (plus « Utilisez l'application d'authentification »),
 *               aucune session émise ;
 *   L111W-BYPASS seconde étape : méthode indisponible ≠ contournement — aucune
 *               session complète, API métier toujours refusées.
 */
import { expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';

const PASSWORD = 'MotDePasseE2e1!';
const ORIGIN = 'http://localhost:3000';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const COOKIES = ['access_token', 'refresh_token', 'vb_device', 'vb_mfa', 'vb_mfa_wa', 'vb_mfa_rc'];
const ENV_KEYS = ['NEXT_PUBLIC_APP_ENV', 'VEREBONA_ENV', 'APP_URL', 'NEXT_PUBLIC_APP_URL', 'WEBAUTHN_RP_ID', 'WEBAUTHN_ORIGINS'] as const;

type WithCookies = Response & { cookies: { get(n: string): { value: string } | undefined } };
let ipN = 1;
class Appareil {
  jar = new Map<string, string>();
  ip = `111.${(ipN++) % 250}.${Math.floor(Math.random() * 250)}.23`;
  absorb(res: Response) {
    for (const n of COOKIES) {
      const v = (res as WithCookies).cookies.get(n)?.value;
      if (v === undefined) continue;
      if (v === '') this.jar.delete(n); else this.jar.set(n, v);
    }
    return res;
  }
  req(path: string, method = 'GET', body?: unknown) {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    return new NextRequest(`${ORIGIN}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': this.ip, 'user-agent': UA, ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}
async function call(app: Appareil, mod: string, method: string, path: string, body?: unknown) {
  const m = await import(/* @vite-ignore */ mod) as Record<string, (r: NextRequest) => Promise<Response>>;
  return app.absorb(await m[method](app.req(path, method, body)));
}
const R = {
  login: '@/app/api/auth/login/route', me: '@/app/api/users/me/route', state: '@/app/api/auth/mfa/state/route',
  pkOptions: '@/app/api/auth/mfa/passkey/options/route', providers: '@/app/api/auth/oauth/providers/route',
  opsMfa: '@/app/api/admin/ops/mfa/route', totpEnroll: '@/app/api/auth/mfa/totp/enroll/route',
};

/** Variables d'environnement modifiées le temps d'un bloc, puis restaurées. */
async function withEnv<T>(patch: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const BROKEN_WEBAUTHN = { WEBAUTHN_RP_ID: 'hote_invalide', WEBAUTHN_ORIGINS: 'https://app.preprod.verebona.fr' };

scenario('L111W', 'MFA préproduction : environnement BO, statut anonyme, messages, aucun contournement', ({ sql, make }) => {
  async function compte(role = 'USER') {
    const email = `${uid('l111w')}@test.invalid`;
    const u = await make.user({ email, role });
    await sql`UPDATE users SET password_hash = ${await bcrypt.hash(PASSWORD, 4)}, is_active = true, status = 'ACTIVE' WHERE id = ${u.id}`;
    await make.account({ owner: u });
    return { id: u.id, email };
  }
  const connexion = async (app: Appareil, email: string) => {
    const res = await call(app, R.login, 'POST', '/api/auth/login', { email, password: PASSWORD });
    expect(res.status).toBe(200);
    return res.json() as Promise<Record<string, unknown>>;
  };
  const obligation = async (scope: 'users' | 'admins', from: Date | null) => {
    await sql`UPDATE mfa_enforcement_settings SET enforced_from = ${from ? from.toISOString() : null} WHERE scope = ${scope}`;
  };

  it('L111W-BO environnement applicatif ≠ NODE_ENV, inconnu sans défaut trompeur, cohérence sans secret', async () => {
    await obligation('admins', null);
    await obligation('users', null);
    const admin = await compte('SUPER_ADMIN');
    const bo = new Appareil();
    await connexion(bo, admin.email);
    const lire = async () => {
      const g = await call(bo, R.opsMfa, 'GET', '/api/admin/ops/mfa');
      expect(g.status).toBe(200);
      return g.json();
    };

    // Préproduction (capture du 05/11) : étiquette explicite, NODE_ENV restitué SÉPARÉMENT.
    const pre = await withEnv({ NEXT_PUBLIC_APP_ENV: 'preprod', APP_URL: 'https://app.preprod.verebona.fr', WEBAUTHN_RP_ID: 'app.preprod.verebona.fr', WEBAUTHN_ORIGINS: 'https://app.preprod.verebona.fr' }, lire);
    expect(pre.environment).toEqual({ key: 'preprod', label: 'Préproduction', variable: 'NEXT_PUBLIC_APP_ENV', nodeEnv: process.env.NODE_ENV });
    expect(pre.webauthn).toMatchObject({ available: true, rpID: 'app.preprod.verebona.fr' });
    expect(pre.appOrigin).toEqual({ origin: 'https://app.preprod.verebona.fr', variable: 'APP_URL' });
    expect(pre.coherence.issues.map((i: { code: string }) => i.code)).not.toContain('RP_ID_HOST_MISMATCH');

    // Absente, même avec l'ancienne VEREBONA_ENV=production : jamais « production ».
    const inconnu = await withEnv({ NEXT_PUBLIC_APP_ENV: undefined, VEREBONA_ENV: 'production' }, lire);
    expect(inconnu.environment).toMatchObject({ key: null, label: 'Inconnu / configuration à vérifier' });
    expect(inconnu.environment.label).not.toMatch(/production/i);
    expect(inconnu.coherence.verdict).toBe('ko');
    expect(inconnu.coherence.issues.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(['ENV_UNKNOWN', 'VEREBONA_ENV_IGNORED']));

    // Discordance RP ID / hôte de l'application : signalée, configuration conservée telle quelle.
    const disc = await withEnv({ NEXT_PUBLIC_APP_ENV: 'preprod', APP_URL: 'https://app.preprod.verebona.fr', WEBAUTHN_RP_ID: 'app.verebona.fr', WEBAUTHN_ORIGINS: 'https://app.verebona.fr' }, lire);
    expect(disc.coherence.verdict).toBe('ko');
    expect(disc.coherence.issues.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(['RP_ID_HOST_MISMATCH', 'APP_ORIGIN_NOT_ALLOWED']));
    // Diagnostic existant conservé (absent ou invalide).
    const ko = await withEnv({ NEXT_PUBLIC_APP_ENV: 'preprod', ...BROKEN_WEBAUTHN }, lire);
    expect(ko.webauthn).toMatchObject({ available: false, problem: 'WEBAUTHN_RP_ID absent ou invalide' });
    for (const v of [pre, inconnu, disc, ko]) expect(JSON.stringify(v)).not.toMatch(/MFA_ENCRYPTION_KEYS=|base64|JWT_SECRET/);
    // L'obligation n'a pas bougé.
    expect(pre.users).toMatchObject({ enforcedFrom: null, active: false });
    expect(pre.admins).toMatchObject({ enforcedFrom: null, active: false });
  });

  it('L111W-PUB statut global anonyme : même réponse avec ou sans session, aucune donnée de compte', async () => {
    const { GET } = await import('@/app/api/auth/oauth/providers/route');
    const ok = await (await GET()).json();
    expect(Object.keys(ok).sort()).toEqual(['apple', 'google', 'passkey']);
    expect(ok.passkey).toBe(true); // configuration de test valide (localhost)
    const res = await GET();
    expect(res.headers.get('cache-control')).toBe('no-store');
    const off = await withEnv(BROKEN_WEBAUTHN, async () => (await GET()).json());
    expect(off.passkey).toBe(false);
    // La route ne lit aucune requête : rien ne peut dépendre d'un compte ou d'un cookie.
    expect(GET.length).toBe(0);
  });

  it('L111W-503 configuration invalide : 503 neutre, aucune session, aucun repli inventé', async () => {
    const anonyme = new Appareil();
    const r = await withEnv(BROKEN_WEBAUTHN, () => call(anonyme, R.pkOptions, 'POST', '/api/auth/mfa/passkey/options', { mode: 'login' }));
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body).toEqual({ error: 'MFA_METHOD_UNAVAILABLE', code: 'MFA_METHOD_UNAVAILABLE', method: 'passkey', message: 'Les clés d’accès ne sont pas disponibles pour le moment.' });
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(anonyme.jar.size).toBe(0);
    // Configuration valide : défi émis normalement (validations inchangées).
    const ok = await call(new Appareil(), R.pkOptions, 'POST', '/api/auth/mfa/passkey/options', { mode: 'login' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).options).toMatchObject({ userVerification: 'required' });
  });

  it('L111W-BYPASS méthode indisponible en seconde étape : jamais de session complète ni d’accès métier', async () => {
    const u = await compte();
    await obligation('users', new Date(Date.now() - 86_400_000));
    try {
      const app = new Appareil();
      expect(await connexion(app, u.email)).toMatchObject({ mfaRequired: true, step: 'enroll' });
      const st = await withEnv(BROKEN_WEBAUTHN, async () => (await call(app, R.state, 'GET', '/api/auth/mfa/state')).json());
      expect(st).toMatchObject({ step: 'enroll', passkeysAvailable: false, totpAvailable: true, methods: { passkey: false, totp: false } });
      const reg = await withEnv(BROKEN_WEBAUTHN, () => call(app, '@/app/api/auth/mfa/passkey/register/route', 'POST', '/api/auth/mfa/passkey/register', { stage: 'options' }));
      expect(reg.status).toBe(503);
      expect((await reg.json()).message).not.toMatch(/application d’authentification/);
      const pending = await withEnv(BROKEN_WEBAUTHN, () => call(app, R.pkOptions, 'POST', '/api/auth/mfa/passkey/options', { mode: 'pending' }));
      expect(pending.status).toBe(503);
      // Aucun contournement : toujours aucune session complète, API métier refusée.
      expect(app.jar.has('access_token')).toBe(false);
      expect((await call(app, R.me, 'GET', '/api/users/me')).status).toBe(401);
      expect(app.jar.has('vb_mfa')).toBe(true);
    } finally {
      await obligation('users', null);
    }
  });
});
