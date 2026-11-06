/**
 * Lot 113M (Trello #705) — préproduction : configuration Passkeys / TOTP,
 * BO et connexion. PostgreSQL 16 réel, VRAIES routes, authentificateur
 * logiciel (`webauthn-soft.ts`) : aucune validation WebAuthn simulée.
 *
 *   L113M-BO     capture du 05/11 reproduite (NODE_ENV=production, préprod,
 *                variables absentes) : « Préproduction » + NODE_ENV à part,
 *                tuiles « À configurer », obligation non activée ; après pose
 *                des variables : « Prêtes », cohérence avec l'association de
 *                l'app mobile (webcredentials / assetlinks), aucun secret ;
 *   L113M-PUB    statut global anonyme `passkey` qui suit la configuration
 *                serveur (même en NODE_ENV=production), sans donnée de compte ;
 *   L113M-PK     préproduction configurée (RP ID app.preprod.verebona.fr) :
 *                enrôlement, connexion sans mot de passe ; origine ou RP ID de
 *                PRODUCTION refusés ; UV exigée ; défi sans compte désigné ;
 *   L113M-ACCOUNT Mon compte › Sécurité : disponibilité serveur des deux
 *                facteurs (`passkeysAvailable`, `totpAvailable`) ;
 *   L113M-BYPASS aucune méthode configurée côté serveur : 503 neutres, jamais
 *                de session complète ni d'accès métier.
 */
import { expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { authenticationResponse, newCredential, registrationResponse } from '../webauthn-soft';

const PASSWORD = 'MotDePasseE2e1!';
const ORIGIN = 'http://localhost:3000';
const PREPROD_ORIGIN = 'https://app.preprod.verebona.fr';
const PREPROD_HOST = 'app.preprod.verebona.fr';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const COOKIES = ['access_token', 'refresh_token', 'vb_device', 'vb_mfa', 'vb_mfa_wa', 'vb_mfa_rc'];
const ENV_KEYS = [
  'NODE_ENV', 'JWT_SECRET', 'NEXT_PUBLIC_APP_ENV', 'VEREBONA_ENV', 'APP_URL', 'NEXT_PUBLIC_APP_URL', 'WEBAUTHN_RP_ID', 'WEBAUTHN_ORIGINS',
  'WEBAUTHN_RP_NAME', 'MFA_ENCRYPTION_KEYS', 'MFA_ENCRYPTION_ACTIVE_KEY', 'MOBILE_IOS_TEAM_ID', 'MOBILE_IOS_BUNDLE_IDS',
  'MOBILE_ANDROID_PACKAGE', 'MOBILE_ANDROID_SHA256_FINGERPRINTS',
] as const;
type EnvPatch = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

// Clé de TEST générée à l'exécution (jamais une valeur réelle) — même format que la recette.
const TEST_KEY = randomBytes(32).toString('base64');
// NODE_ENV=production exige un JWT_SECRET (refus du repli de développement) : valeur de test, pour TOUT le bloc.
const TEST_JWT_SECRET = randomBytes(48).toString('base64');
/** Préproduction telle que la capture du 05/11 : déployée (NODE_ENV=production), variables MFA absentes. */
const PREPROD_BARE: EnvPatch = {
  NODE_ENV: 'production', JWT_SECRET: TEST_JWT_SECRET, NEXT_PUBLIC_APP_ENV: 'preprod', VEREBONA_ENV: undefined, APP_URL: PREPROD_ORIGIN,
  WEBAUTHN_RP_ID: undefined, WEBAUTHN_ORIGINS: undefined, WEBAUTHN_RP_NAME: undefined,
  MFA_ENCRYPTION_KEYS: undefined, MFA_ENCRYPTION_ACTIVE_KEY: undefined,
  MOBILE_IOS_TEAM_ID: undefined, MOBILE_IOS_BUNDLE_IDS: undefined, MOBILE_ANDROID_PACKAGE: undefined, MOBILE_ANDROID_SHA256_FINGERPRINTS: undefined,
};
/** Après la recette 113M § 4 (variables WebAuthn + trousseau). */
const PREPROD_CONFIGURED: EnvPatch = {
  ...PREPROD_BARE, WEBAUTHN_RP_ID: PREPROD_HOST, WEBAUTHN_ORIGINS: PREPROD_ORIGIN, WEBAUTHN_RP_NAME: 'Verebona',
  MFA_ENCRYPTION_KEYS: `k2026a:${TEST_KEY}`,
};
const MOBILE_ASSOCIATION: EnvPatch = {
  MOBILE_IOS_TEAM_ID: 'ABCDE12345', MOBILE_IOS_BUNDLE_IDS: 'fr.verebona.app.preprod',
  MOBILE_ANDROID_PACKAGE: 'fr.verebona.app.preprod', MOBILE_ANDROID_SHA256_FINGERPRINTS: Array.from({ length: 32 }, () => 'AB').join(':'),
};

type WithCookies = Response & { cookies: { get(n: string): { value: string } | undefined } };
let ipN = 1;
class Appareil {
  jar = new Map<string, string>();
  ip = `113.${(ipN++) % 250}.${Math.floor(Math.random() * 250)}.13`;
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
  pkOptions: '@/app/api/auth/mfa/passkey/options/route', pkVerify: '@/app/api/auth/mfa/passkey/verify/route',
  pkRegister: '@/app/api/auth/mfa/passkey/register/route', codesConfirm: '@/app/api/auth/mfa/recovery-codes/confirm/route',
  totpEnroll: '@/app/api/auth/mfa/totp/enroll/route', opsMfa: '@/app/api/admin/ops/mfa/route',
  security: '@/app/api/users/me/security/mfa/route',
};

/** Variables modifiées le temps d'un bloc, puis restaurées (NODE_ENV compris). */
async function withEnv<T>(patch: EnvPatch, fn: () => Promise<T>): Promise<T> {
  const env = process.env as Record<string, string | undefined>;
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k]]));
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete env[k]; else env[k] = v; }
  try { return await fn(); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete env[k]; else env[k] = saved[k]; }
  }
}
const codesOf = (r: { coherence: { issues: { code: string }[] } }) => r.coherence.issues.map((i) => i.code);

scenario('L113M', 'MFA préproduction #705 : configuration, BO, connexion par clé d’accès, aucun contournement', ({ sql, make }) => {
  async function compte(role = 'USER') {
    const email = `${uid('l113m')}@test.invalid`;
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

  it('L113M-BO capture du 05/11 puis configuration : Préproduction ≠ NODE_ENV, tuiles, association mobile, aucun secret', async () => {
    await obligation('admins', null);
    await obligation('users', null);
    const admin = await compte('SUPER_ADMIN');
    const bo = new Appareil();
    // Tout le bloc en « préproduction déployée » (NODE_ENV=production, JWT_SECRET de test).
    await withEnv(PREPROD_BARE, async () => {
      await connexion(bo, admin.email);
      const lire = async () => {
        const g = await call(bo, R.opsMfa, 'GET', '/api/admin/ops/mfa');
        expect(g.status).toBe(200);
        return g.json();
      };

      // Avant : préprod déployée, rien de posé.
      const avant = await lire();
      expect(avant.environment).toEqual({ key: 'preprod', label: 'Préproduction', variable: 'NEXT_PUBLIC_APP_ENV', nodeEnv: 'production' });
      expect(avant.webauthn).toMatchObject({ available: false, rpID: null, origins: [], problem: 'WEBAUTHN_RP_ID absent ou invalide' });
      expect(avant.totpKeys).toMatchObject({ configured: false, activeKeyId: null, problem: 'MFA_ENCRYPTION_KEYS absent' });
      expect(avant.users).toMatchObject({ enforcedFrom: null, active: false });
      expect(avant.admins).toMatchObject({ enforcedFrom: null, active: false });
      expect(codesOf(avant)).toContain('WEBAUTHN_NOT_CHECKED');

      // Après pose des variables, sans association mobile : « Prêtes », mais l'app iPhone / Android est signalée.
      const apres = await withEnv(PREPROD_CONFIGURED, lire);
      expect(apres.environment.label).toBe('Préproduction');
      expect(apres.environment.nodeEnv).toBe('production');
      expect(apres.webauthn).toMatchObject({ available: true, rpID: PREPROD_HOST, origins: [PREPROD_ORIGIN] });
      expect(apres.totpKeys).toMatchObject({ configured: true, activeKeyId: 'k2026a', keyIds: ['k2026a'], problem: null });
      expect(apres.coherence.verdict).toBe('warn');
      expect(codesOf(apres)).toEqual(['IOS_WEBCREDENTIALS_MISSING', 'ANDROID_ASSETLINKS_MISSING']);

      // Association de l'app de PRÉPROD : cohérente.
      const complet = await withEnv({ ...PREPROD_CONFIGURED, ...MOBILE_ASSOCIATION }, lire);
      expect(complet.coherence).toEqual({ verdict: 'ok', issues: [] });
      // App de PRODUCTION déclarée par erreur en préproduction : signalée.
      const mauvaiseApp = await withEnv({ ...PREPROD_CONFIGURED, ...MOBILE_ASSOCIATION, MOBILE_IOS_BUNDLE_IDS: 'fr.verebona.app', MOBILE_ANDROID_PACKAGE: 'fr.verebona.app' }, lire);
      expect(codesOf(mauvaiseApp)).toEqual(['IOS_WEBCREDENTIALS_APP_MISSING', 'ANDROID_ASSETLINKS_APP_MISMATCH']);

      for (const v of [avant, apres, complet, mauvaiseApp]) {
        const json = JSON.stringify(v);
        expect(json).not.toContain(TEST_KEY);
        expect(v.environment.label).toBe('Préproduction');
      }
      // L'obligation n'a pas bougé pendant toute la lecture.
      expect((await sql`SELECT COUNT(*)::int AS n FROM mfa_enforcement_settings WHERE enforced_from IS NOT NULL`)[0].n).toBe(0);
    });
  });

  it('L113M-PUB statut global anonyme : suit la configuration serveur, aucune donnée de compte', async () => {
    const { GET } = await import('@/app/api/auth/oauth/providers/route');
    const avant = await withEnv(PREPROD_BARE, async () => (await GET()).json());
    expect(avant.passkey).toBe(false);
    const apres = await withEnv(PREPROD_CONFIGURED, async () => (await GET()).json());
    expect(apres.passkey).toBe(true);
    expect(Object.keys(apres).sort()).toEqual(['apple', 'google', 'passkey']);
    expect(GET.length).toBe(0); // aucune lecture de requête : rien ne dépend d'un compte ni d'un cookie
  });

  it('L113M-PK préproduction configurée : enrôlement, connexion sans mot de passe, origine / RP ID de production refusés', async () => {
    const u = await compte();
    await obligation('users', new Date(Date.now() - 86_400_000));
    try {
      await withEnv(PREPROD_CONFIGURED, async () => {
        const a = new Appareil();
        expect(await connexion(a, u.email)).toMatchObject({ mfaRequired: true, step: 'enroll' });
        const st = await (await call(a, R.state, 'GET', '/api/auth/mfa/state')).json();
        expect(st).toMatchObject({ step: 'enroll', passkeysAvailable: true, totpAvailable: true, methods: { passkey: false, totp: false } });

        const cred = newCredential();
        cred.userHandle = Buffer.from(`vb-user-${u.id}`).toString('base64url');
        let o = await (await call(a, R.pkRegister, 'POST', '/api/auth/mfa/passkey/register', { stage: 'options' })).json();
        expect(o.options.rp).toEqual({ id: PREPROD_HOST, name: 'Verebona' });
        // Origine de PRODUCTION présentée en préproduction : refusée.
        expect((await call(a, R.pkRegister, 'POST', '/api/auth/mfa/passkey/register', { stage: 'verify', challengeId: o.challengeId, response: registrationResponse(cred, o.options, { origin: 'https://app.verebona.fr' }) })).status).toBe(401);
        // RP ID de production : refusé.
        o = await (await call(a, R.pkRegister, 'POST', '/api/auth/mfa/passkey/register', { stage: 'options' })).json();
        expect((await call(a, R.pkRegister, 'POST', '/api/auth/mfa/passkey/register', { stage: 'verify', challengeId: o.challengeId, response: registrationResponse(cred, o.options, { origin: PREPROD_ORIGIN, rpId: 'app.verebona.fr' }) })).status).toBe(401);
        expect((await sql`SELECT COUNT(*)::int AS n FROM mfa_passkeys WHERE user_id = ${u.id}`)[0].n).toBe(0);
        // Cérémonie conforme.
        o = await (await call(a, R.pkRegister, 'POST', '/api/auth/mfa/passkey/register', { stage: 'options' })).json();
        expect((await call(a, R.pkRegister, 'POST', '/api/auth/mfa/passkey/register', { stage: 'verify', challengeId: o.challengeId, response: registrationResponse(cred, o.options, { origin: PREPROD_ORIGIN }) })).status).toBe(200);
        expect((await call(a, R.codesConfirm, 'POST', '/api/auth/mfa/recovery-codes/confirm', { confirmed: true })).status).toBe(200);
        expect(a.jar.has('access_token')).toBe(true);

        // Connexion SANS mot de passe depuis un autre appareil : défi sans compte désigné (anti-énumération).
        const p = new Appareil();
        const lo = await (await call(p, R.pkOptions, 'POST', '/api/auth/mfa/passkey/options', { mode: 'login' })).json();
        expect(lo.options).toMatchObject({ rpId: PREPROD_HOST, userVerification: 'required' });
        expect(lo.options.allowCredentials ?? []).toEqual([]);
        expect(JSON.stringify(lo)).not.toContain(u.email);
        // UV absente : refusée.
        expect((await call(p, R.pkVerify, 'POST', '/api/auth/mfa/passkey/verify', { mode: 'login', challengeId: lo.challengeId, response: authenticationResponse(cred, { challenge: lo.options.challenge, rpId: lo.options.rpId }, { origin: PREPROD_ORIGIN, uv: false }) })).status).toBe(401);
        expect(p.jar.has('access_token')).toBe(false);
        const lo2 = await (await call(p, R.pkOptions, 'POST', '/api/auth/mfa/passkey/options', { mode: 'login' })).json();
        const ok = await call(p, R.pkVerify, 'POST', '/api/auth/mfa/passkey/verify', { mode: 'login', challengeId: lo2.challengeId, response: authenticationResponse(cred, { challenge: lo2.options.challenge, rpId: lo2.options.rpId }, { origin: PREPROD_ORIGIN }) });
        expect(ok.status).toBe(200);
        expect(p.jar.has('access_token')).toBe(true);

        // L113M-ACCOUNT Mon compte › Sécurité : les deux facteurs disponibles côté serveur.
        const sec = await (await call(p, R.security, 'GET', '/api/users/me/security/mfa')).json();
        expect(sec).toMatchObject({ passkeysAvailable: true, totpAvailable: true });
        expect(sec.passkeys).toHaveLength(1);
        expect(JSON.stringify(sec)).not.toContain(TEST_KEY);
        // Même session, trousseau retiré : l'application d'authentification n'est plus proposée à l'ajout (sans détail).
        const sansCle = await withEnv({ MFA_ENCRYPTION_KEYS: undefined }, async () => (await call(p, R.security, 'GET', '/api/users/me/security/mfa')).json());
        expect(sansCle).toMatchObject({ passkeysAvailable: true, totpAvailable: false });
      });
    } finally {
      await obligation('users', null);
    }
  });

  it('L113M-BYPASS aucune méthode configurée (capture du 05/11) : 503 neutres, jamais de session complète', async () => {
    const u = await compte();
    await obligation('users', new Date(Date.now() - 86_400_000));
    try {
      await withEnv(PREPROD_BARE, async () => {
        const app = new Appareil();
        expect(await connexion(app, u.email)).toMatchObject({ mfaRequired: true, step: 'enroll' });
        const st = await (await call(app, R.state, 'GET', '/api/auth/mfa/state')).json();
        expect(st).toMatchObject({ step: 'enroll', passkeysAvailable: false, totpAvailable: false, methods: { passkey: false, totp: false } });

        const pk = await call(app, R.pkRegister, 'POST', '/api/auth/mfa/passkey/register', { stage: 'options' });
        expect(pk.status).toBe(503);
        expect(await pk.json()).toMatchObject({ code: 'MFA_METHOD_UNAVAILABLE', method: 'passkey', message: 'Les clés d’accès ne sont pas disponibles pour le moment.' });
        const totp = await call(app, R.totpEnroll, 'POST', '/api/auth/mfa/totp/enroll', { stage: 'start' });
        expect(totp.status).toBe(503);
        const tb = await totp.json();
        expect(tb).toMatchObject({ code: 'MFA_METHOD_UNAVAILABLE', method: 'totp' });
        expect(tb.message).not.toMatch(/clé d’accès/);

        // Connexion anonyme par clé : 503 neutre (aucun facteur supposé), aucun cookie.
        const anonyme = new Appareil();
        const lo = await call(anonyme, R.pkOptions, 'POST', '/api/auth/mfa/passkey/options', { mode: 'login' });
        expect(lo.status).toBe(503);
        expect((await lo.json()).message).toBe('Les clés d’accès ne sont pas disponibles pour le moment.');
        expect(anonyme.jar.size).toBe(0);

        // Aucun contournement : ni session complète, ni API métier.
        expect(app.jar.has('access_token')).toBe(false);
        expect((await call(app, R.me, 'GET', '/api/users/me')).status).toBe(401);
        expect(app.jar.has('vb_mfa')).toBe(true);
      });
    } finally {
      await obligation('users', null);
    }
  });
});
