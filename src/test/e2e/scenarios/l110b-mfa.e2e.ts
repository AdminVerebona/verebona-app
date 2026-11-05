/**
 * Lot 110B — double authentification (passkeys WebAuthn / TOTP / codes de
 * récupération, garde serveur, step-up). PostgreSQL 16 réel (migrations
 * 1165-1168), VRAIES routes, authentificateur WebAuthn logiciel.
 *
 *   L110B-ACT   activation contrôlée : avant = inchangé ; après = anciennes
 *               sessions sous garde dès la 1re requête, refresh non promouvant,
 *               aucune session complète avant la preuve forte ; jeton
 *               provisoire sans aucun accès ;
 *   L110B-TOTP  enrôlement (premier code vérifié), 10 codes, session de
 *               niveau 2, anti-rejeu par intervalle, secret chiffré, e-mail ;
 *   L110B-BACK  retour arrière : un compte protégé le reste ;
 *   L110B-THR   limitation compte (429), suppression du compte (cascade) ;
 *   L110B-PK    clé d'accès : UV exigée, défi à usage unique, origine,
 *               connexion sans mot de passe, mot de passe seul jamais suffisant ;
 *   L110B-STEP  step-up fort (mot de passe refusé, clé d'accès), paramètre
 *               historique du corps contrôlé, dernière méthode protégée,
 *               isolation entre comptes (Duo) ;
 *   L110B-OAUTH Google / Apple + facteur ;
 *   L110B-REC   récupération (e-mail + code), sessions révoquées, code usage unique ;
 *   L110B-ADM   obligation administrateurs séparée.
 */
import { expect, it } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { authenticationResponse, newCredential, registrationResponse } from '../webauthn-soft';

const PASSWORD = 'MotDePasseE2e1!';
const ORIGIN = 'http://localhost:3000';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const COOKIES = ['access_token', 'refresh_token', 'vb_device', 'vb_mfa', 'vb_mfa_wa', 'vb_mfa_rc'];

type WithCookies = Response & { cookies: { get(n: string): { value: string } | undefined } };
const cookieOf = (res: Response, name: string) => (res as WithCookies).cookies.get(name)?.value;

let ipN = 1;
class Appareil {
  jar = new Map<string, string>();
  ip = `110.${(ipN++) % 250}.${Math.floor(Math.random() * 250)}.7`;
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  absorb(res: Response) {
    for (const n of COOKIES) {
      const v = cookieOf(res, n);
      if (v === undefined) continue;
      if (v === '') this.jar.delete(n); else this.jar.set(n, v);
    }
    return res;
  }
  req(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
    return new NextRequest(`${ORIGIN}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': this.ip, 'user-agent': UA, ...(this.jar.size ? { cookie: this.cookie() } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}

async function call(app: Appareil, mod: string, method: string, path: string, body?: unknown, params?: Record<string, string>) {
  const m = await import(/* @vite-ignore */ mod) as Record<string, (r: NextRequest, c?: unknown) => Promise<Response>>;
  const res = await m[method](app.req(path, method, body), params ? { params: Promise.resolve(params) } : undefined);
  app.absorb(res);
  return res;
}
const R = {
  login: '@/app/api/auth/login/route', refresh: '@/app/api/auth/refresh/route', logout: '@/app/api/auth/logout/route',
  me: '@/app/api/users/me/route', authMe: '@/app/api/auth/me/route',
  state: '@/app/api/auth/mfa/state/route', totpEnroll: '@/app/api/auth/mfa/totp/enroll/route', totpVerify: '@/app/api/auth/mfa/totp/verify/route',
  codesConfirm: '@/app/api/auth/mfa/recovery-codes/confirm/route', pkRegister: '@/app/api/auth/mfa/passkey/register/route',
  pkOptions: '@/app/api/auth/mfa/passkey/options/route', pkVerify: '@/app/api/auth/mfa/passkey/verify/route',
  recStart: '@/app/api/auth/mfa/recovery/start/route', recVerify: '@/app/api/auth/mfa/recovery/verify/route',
  reauth: '@/app/api/users/me/security/reauth/route', reauthPk: '@/app/api/users/me/security/reauth/passkey/route',
  mfaSummary: '@/app/api/users/me/security/mfa/route', codesRegen: '@/app/api/users/me/security/mfa/recovery-codes/route',
  pkItem: '@/app/api/users/me/security/mfa/passkeys/[id]/route', changePassword: '@/app/api/users/me/change-password/route',
  accountTotp: '@/app/api/users/me/security/mfa/totp/route', opsMfa: '@/app/api/admin/ops/mfa/route',
};

scenario('L110B', 'Double authentification : passkeys, TOTP, codes, garde serveur, step-up', ({ sql, make }) => {
  async function compte(role = 'USER') {
    const email = `${uid('l110b')}@test.invalid`;
    const u = await make.user({ email, role });
    await sql`UPDATE users SET password_hash = ${await bcrypt.hash(PASSWORD, 4)}, is_active = true, status = 'ACTIVE' WHERE id = ${u.id}`;
    await make.account({ owner: u });
    return { id: u.id, email };
  }
  const obligation = async (scope: 'users' | 'admins', from: Date | null) => {
    await sql`UPDATE mfa_enforcement_settings SET enforced_from = ${from ? from.toISOString() : null} WHERE scope = ${scope}`;
  };
  const hier = () => new Date(Date.now() - 86_400_000);
  const connexion = async (app: Appareil, email: string) => {
    const res = await call(app, R.login, 'POST', '/api/auth/login', { email, password: PASSWORD });
    expect(res.status).toBe(200);
    return res.json() as Promise<Record<string, unknown>>;
  };
  const totpCode = async (secret: string, offsetMs = 0) => (await import('@/lib/auth/mfa/totp')).__totpCodeForTests(secret, Date.now() + offsetMs);
  const payloadOf = async (app: Appareil) => (await import('@/lib/jwt')).verifyAccessToken(app.jar.get('access_token')!);
  /** E-mails de sécurité (émis sans attente) : lecture après quelques essais. */
  const outbox = async (userId: number, attendus: string[] = []) => {
    let rows: { recipient_user_id: number; payload_json: { event: string } }[] = [];
    for (let i = 0; i < 40; i++) {
      rows = await sql<{ recipient_user_id: number; payload_json: { event: string } }[]>`
        SELECT recipient_user_id, payload_json FROM notification_outbox WHERE event_type = 'MFA_SECURITY_EVENT' AND recipient_user_id = ${userId} ORDER BY created_at`;
      if (attendus.every((e) => rows.some((r) => r.payload_json.event === e))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    return rows;
  };

  /** Enrôlement TOTP complet dans le contexte provisoire ; rend le secret et les codes. */
  async function enrolerTotp(app: Appareil) {
    const s = await call(app, R.totpEnroll, 'POST', '/api/auth/mfa/totp/enroll', { stage: 'start' });
    expect(s.status).toBe(200);
    const { secret, otpauthUri, qrSvg } = await s.json();
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\/Verebona:/);
    expect(qrSvg).toMatch(/^<svg/);
    const c = await call(app, R.totpEnroll, 'POST', '/api/auth/mfa/totp/enroll', { stage: 'confirm', code: await totpCode(secret) });
    expect(c.status).toBe(200);
    const { recoveryCodes } = await c.json();
    return { secret: secret as string, codes: recoveryCodes as string[] };
  }

  it('L110B-ACT / L110B-TOTP / L110B-BACK : activation, anciennes sessions, enrôlement TOTP, anti-rejeu, retour arrière', async () => {
    await obligation('users', null);
    const u = await compte();
    const ancien = new Appareil();
    // Avant activation : comportement INCHANGÉ (session complète de niveau 1).
    const avant = await connexion(ancien, u.email);
    expect(avant.mfaRequired).toBeUndefined();
    expect((await payloadOf(ancien))?.aal).toBe(1);
    expect((await call(ancien, R.me, 'GET', '/api/users/me')).status).toBe(200);

    // Activation (date passée) : la session existante est sous garde dès la première requête métier.
    await obligation('users', hier());
    const refus = await call(ancien, R.me, 'GET', '/api/users/me');
    expect(refus.status).toBe(403);
    expect((await refus.json()).code).toBe('MFA_REQUIRED');
    expect((await call(ancien, R.authMe, 'GET', '/api/auth/me')).status).toBe(403);
    // Renouvellement : rotation permise, JAMAIS promue.
    expect((await call(ancien, R.refresh, 'POST', '/api/auth/refresh')).status).toBe(200);
    expect((await payloadOf(ancien))?.aal).toBe(1);
    expect((await call(ancien, R.me, 'GET', '/api/users/me')).status).toBe(403);

    // Nouvelle connexion : aucune session complète, contexte provisoire d'enrôlement.
    const nouveau = new Appareil();
    const r = await connexion(nouveau, u.email);
    expect(r).toMatchObject({ mfaRequired: true, step: 'enroll', redirectTo: '/securiser-mon-compte' });
    expect(nouveau.jar.has('access_token')).toBe(false);
    expect(nouveau.jar.has('refresh_token')).toBe(false);
    expect(nouveau.jar.has('vb_mfa')).toBe(true);
    // Le jeton provisoire n'ouvre AUCUNE API métier (cookie ni Bearer).
    expect((await call(nouveau, R.me, 'GET', '/api/users/me')).status).toBe(401);
    const bearer = new Appareil();
    const { GET: me } = await import('@/app/api/users/me/route');
    expect((await me(bearer.req('/api/users/me', 'GET', undefined, { authorization: `Bearer ${nouveau.jar.get('vb_mfa')}` }))).status).toBe(401);
    // Une étape « challenge » n'est pas possible sans facteur.
    expect((await call(nouveau, R.totpVerify, 'POST', '/api/auth/mfa/totp/verify', { code: '123456' })).status).toBe(409);

    // Enrôlement TOTP : un code faux n'active rien.
    const s = await (await call(nouveau, R.totpEnroll, 'POST', '/api/auth/mfa/totp/enroll', { stage: 'start' })).json();
    expect((await call(nouveau, R.totpEnroll, 'POST', '/api/auth/mfa/totp/enroll', { stage: 'confirm', code: '000000' })).status).toBe(401);
    expect((await sql`SELECT status FROM mfa_totp_factors WHERE user_id = ${u.id}`).map((x) => x.status)).toEqual(['PENDING']);
    const c = await call(nouveau, R.totpEnroll, 'POST', '/api/auth/mfa/totp/enroll', { stage: 'confirm', code: await totpCode(s.secret) });
    expect(c.status).toBe(200);
    const { recoveryCodes } = await c.json();
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const rc of recoveryCodes) expect(rc).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    // Toujours aucune session complète avant la confirmation de conservation des codes.
    expect(nouveau.jar.has('access_token')).toBe(false);
    expect((await call(nouveau, R.codesConfirm, 'POST', '/api/auth/mfa/recovery-codes/confirm', {})).status).toBe(400);
    const fin = await call(nouveau, R.codesConfirm, 'POST', '/api/auth/mfa/recovery-codes/confirm', { confirmed: true });
    expect(fin.status).toBe(200);
    expect(nouveau.jar.has('vb_mfa')).toBe(false);
    expect(await payloadOf(nouveau)).toMatchObject({ aal: 2, amr: ['pwd', 'otp'] });
    expect((await call(nouveau, R.me, 'GET', '/api/users/me')).status).toBe(200);
    // Le contexte provisoire est à usage unique.
    expect((await call(nouveau, R.state, 'GET', '/api/auth/mfa/state')).status).toBe(401);

    // Stockage : secret CHIFFRÉ, empreintes seules, compte protégé ; e-mail au titulaire seul.
    const [f] = await sql<{ secret_ciphertext: string; key_id: string; status: string }[]>`SELECT secret_ciphertext, key_id, status FROM mfa_totp_factors WHERE user_id = ${u.id}`;
    expect(f.status).toBe('ACTIVE');
    expect(f.secret_ciphertext).not.toContain(s.secret);
    expect(f.secret_ciphertext).toMatch(/^v1\./);
    const hashes = await sql<{ code_hash: string }[]>`SELECT code_hash FROM mfa_recovery_codes WHERE user_id = ${u.id}`;
    expect(hashes).toHaveLength(10);
    for (const h of hashes) expect(recoveryCodes.map((x: string) => x.replace(/-/g, ''))).not.toContain(h.code_hash);
    expect((await sql`SELECT enabled_at FROM user_mfa_state WHERE user_id = ${u.id}`)[0].enabled_at).not.toBeNull();
    expect((await outbox(u.id, ['totp_enabled'])).map((o) => o.payload_json.event)).toContain('totp_enabled');
    const journal = await sql<{ details: string }[]>`SELECT details::text AS details FROM user_activity_log WHERE user_id = ${u.id}`;
    expect(JSON.stringify(journal)).not.toContain(s.secret);
    for (const rc of recoveryCodes) expect(JSON.stringify(journal)).not.toContain(rc);

    // Seconde étape : le code déjà utilisé (même intervalle) est REFUSÉ (anti-rejeu) ; le suivant passe.
    await call(nouveau, R.logout, 'POST', '/api/auth/logout');
    const again = new Appareil();
    expect(await connexion(again, u.email)).toMatchObject({ mfaRequired: true, step: 'challenge', redirectTo: '/verification' });
    const st = await (await call(again, R.state, 'GET', '/api/auth/mfa/state')).json();
    expect(st).toMatchObject({ step: 'challenge', methods: { passkey: false, totp: true } });
    expect(JSON.stringify(st)).not.toMatch(/secret|code_hash/i);
    expect((await call(again, R.totpVerify, 'POST', '/api/auth/mfa/totp/verify', { code: await totpCode(s.secret) })).status).toBe(401);
    expect((await call(again, R.totpVerify, 'POST', '/api/auth/mfa/totp/verify', { code: await totpCode(s.secret, 30_000) })).status).toBe(200);
    expect(await payloadOf(again)).toMatchObject({ aal: 2 });

    // Retour arrière : l'obligation est retirée, le compte PROTÉGÉ le reste (ancienne session toujours refusée).
    await obligation('users', null);
    expect((await call(ancien, R.me, 'GET', '/api/users/me')).status).toBe(403);
    const libre = await compte();
    const l = new Appareil();
    expect((await connexion(l, libre.email)).mfaRequired).toBeUndefined();
    expect((await call(l, R.me, 'GET', '/api/users/me')).status).toBe(200);
  });

  it('L110B-THR limitation par compte (429) ; suppression du compte : facteurs et secrets supprimés (cascade)', async () => {
    await obligation('users', hier());
    const u = await compte();
    const a = new Appareil();
    await connexion(a, u.email);
    await enrolerTotp(a);
    const b = new Appareil();
    await connexion(b, u.email);
    for (let i = 0; i < 5; i++) expect((await call(b, R.totpVerify, 'POST', '/api/auth/mfa/totp/verify', { code: '000000' })).status).toBe(401);
    const bloque = await call(b, R.totpVerify, 'POST', '/api/auth/mfa/totp/verify', { code: '000000' });
    expect(bloque.status).toBe(429);
    expect(JSON.stringify(await sql`SELECT details FROM user_activity_log WHERE user_id = ${u.id} AND activity_type IN ('MFA_FAILED','MFA_THROTTLED')`)).not.toMatch(/000000/);
    await sql`DELETE FROM accounts WHERE owner_user_id = ${u.id}`;
    await sql`DELETE FROM users WHERE id = ${u.id}`;
    for (const t of ['user_mfa_state', 'mfa_totp_factors', 'mfa_recovery_codes', 'mfa_pending_auth', 'mfa_passkeys']) {
      expect((await sql.unsafe(`SELECT COUNT(*)::int AS n FROM ${t} WHERE user_id = ${u.id}`))[0].n, t).toBe(0);
    }
    await obligation('users', null);
  });

  it('L110B-PK / L110B-STEP / L110B-OAUTH clés d’accès, step-up fort, isolation, Google + facteur', async () => {
    await obligation('users', hier());
    const u = await compte();
    const a = new Appareil();
    await connexion(a, u.email);
    const cred = newCredential();
    cred.userHandle = Buffer.from(`vb-user-${u.id}`).toString('base64url');
    // UV absente : refusée.
    let o = await (await call(a, R.pkRegister, 'POST', '/api/auth/mfa/passkey/register', { stage: 'options' })).json();
    expect(o.options.authenticatorSelection).toMatchObject({ userVerification: 'required', residentKey: 'required' });
    expect((await call(a, R.pkRegister, 'POST', '/api/auth/mfa/passkey/register', { stage: 'verify', challengeId: o.challengeId, response: registrationResponse(cred, o.options, { origin: ORIGIN, uv: false }) })).status).toBe(401);
    // Mauvaise origine : refusée.
    o = await (await call(a, R.pkRegister, 'POST', '/api/auth/mfa/passkey/register', { stage: 'options' })).json();
    expect((await call(a, R.pkRegister, 'POST', '/api/auth/mfa/passkey/register', { stage: 'verify', challengeId: o.challengeId, response: registrationResponse(cred, o.options, { origin: 'https://evil.example' }) })).status).toBe(401);
    expect((await sql`SELECT COUNT(*)::int AS n FROM mfa_passkeys WHERE user_id = ${u.id}`)[0].n).toBe(0);
    // Validation complète.
    o = await (await call(a, R.pkRegister, 'POST', '/api/auth/mfa/passkey/register', { stage: 'options' })).json();
    const reg = registrationResponse(cred, o.options, { origin: ORIGIN });
    const ok = await call(a, R.pkRegister, 'POST', '/api/auth/mfa/passkey/register', { stage: 'verify', challengeId: o.challengeId, response: reg });
    expect(ok.status).toBe(200);
    // Défi à usage unique.
    expect((await call(a, R.pkRegister, 'POST', '/api/auth/mfa/passkey/register', { stage: 'verify', challengeId: o.challengeId, response: reg })).status).toBe(409);
    expect((await call(a, R.codesConfirm, 'POST', '/api/auth/mfa/recovery-codes/confirm', { confirmed: true })).status).toBe(200);
    expect(await payloadOf(a)).toMatchObject({ aal: 2, amr: ['pwd', 'passkey'] });
    const [pk] = await sql<{ id: number; public_key: string; backed_up: boolean }[]>`SELECT id, public_key, backed_up FROM mfa_passkeys WHERE user_id = ${u.id}`;
    expect(pk.backed_up).toBe(true);

    // Connexion SANS mot de passe (clé découvrable), puis défi rejoué refusé.
    const p = new Appareil();
    const lo = await (await call(p, R.pkOptions, 'POST', '/api/auth/mfa/passkey/options', { mode: 'login' })).json();
    expect(lo.options.userVerification).toBe('required');
    expect(lo.options.allowCredentials ?? []).toEqual([]);
    cred.counter = 0;
    const assertion = authenticationResponse(cred, { challenge: lo.options.challenge, rpId: lo.options.rpId }, { origin: ORIGIN });
    expect((await call(p, R.pkVerify, 'POST', '/api/auth/mfa/passkey/verify', { mode: 'login', challengeId: lo.challengeId, response: assertion })).status).toBe(200);
    expect(await payloadOf(p)).toMatchObject({ aal: 2, amr: ['passkey'] });
    const p2 = new Appareil();
    p2.jar.set('vb_mfa_wa', 'autre-navigateur');
    expect((await call(p2, R.pkVerify, 'POST', '/api/auth/mfa/passkey/verify', { mode: 'login', challengeId: lo.challengeId, response: assertion })).status).toBe(401);
    // UV absente à la connexion : refusée.
    const lo2 = await (await call(p2, R.pkOptions, 'POST', '/api/auth/mfa/passkey/options', { mode: 'login' })).json();
    expect((await call(p2, R.pkVerify, 'POST', '/api/auth/mfa/passkey/verify', { mode: 'login', challengeId: lo2.challengeId, response: authenticationResponse(cred, { challenge: lo2.options.challenge, rpId: lo2.options.rpId }, { origin: ORIGIN, uv: false }) })).status).toBe(401);

    // Mot de passe seul : jamais suffisant (le compte n'a qu'une clé d'accès).
    const m = new Appareil();
    expect(await connexion(m, u.email)).toMatchObject({ mfaRequired: true, step: 'challenge' });
    expect((await (await call(m, R.state, 'GET', '/api/auth/mfa/state')).json()).methods).toEqual({ passkey: true, totp: false });
    expect((await call(m, R.totpVerify, 'POST', '/api/auth/mfa/totp/verify', { code: '123456' })).status).toBe(401);
    expect(m.jar.has('access_token')).toBe(false);

    // Step-up : mot de passe refusé (preuve faible), paramètre historique du corps sans effet.
    const stepPwd = await call(p, R.reauth, 'POST', '/api/users/me/security/reauth', { method: 'password', password: PASSWORD });
    expect(stepPwd.status).toBe(403);
    expect((await stepPwd.json()).code).toBe('MFA_STEP_UP_REQUIRED');
    const regen0 = await call(p, R.codesRegen, 'POST', '/api/users/me/security/mfa/recovery-codes', {});
    expect(regen0.status).toBe(403);
    expect(await regen0.json()).toMatchObject({ code: 'REAUTH_REQUIRED', stepUp: 'MFA_STEP_UP_REQUIRED' });
    const cp = await call(p, R.changePassword, 'POST', '/api/users/me/change-password', { currentPassword: PASSWORD, newPassword: 'NouveauMdp2026!x' });
    expect(cp.status).toBe(403);
    // Step-up par clé d'accès (5 min, lié à la session) → régénération des codes.
    const so = await (await call(p, R.reauthPk, 'POST', '/api/users/me/security/reauth/passkey', { stage: 'options' })).json();
    expect(so.options.userVerification).toBe('required');
    cred.counter = 0;
    expect((await call(p, R.reauthPk, 'POST', '/api/users/me/security/reauth/passkey', { stage: 'verify', challengeId: so.challengeId, response: authenticationResponse(cred, { challenge: so.options.challenge, rpId: so.options.rpId }, { origin: ORIGIN }) })).status).toBe(200);
    expect((await sql`SELECT assurance FROM reauth_proofs WHERE user_id = ${u.id}`)[0].assurance).toBe(2);
    const regen = await call(p, R.codesRegen, 'POST', '/api/users/me/security/mfa/recovery-codes', {});
    expect(regen.status).toBe(200);
    expect((await regen.json()).recoveryCodes).toHaveLength(10);
    expect((await outbox(u.id, ['passkey_added', 'recovery_regenerated'])).map((x) => x.payload_json.event)).toEqual(expect.arrayContaining(['passkey_added', 'recovery_regenerated']));
    // Dernière méthode forte : jamais retirée.
    const del = await call(p, R.pkItem, 'DELETE', `/api/users/me/security/mfa/passkeys/${pk.id}`, undefined, { id: String(pk.id) });
    expect(del.status).toBe(409);
    expect((await del.json()).code).toBe('MFA_LAST_METHOD');

    // Isolation (Duo compris) : un autre compte ne voit ni ne retire la clé de celui-ci.
    const autre = await compte();
    const x = new Appareil();
    await connexion(x, autre.email);
    await enrolerTotp(x);
    await call(x, R.codesConfirm, 'POST', '/api/auth/mfa/recovery-codes/confirm', { confirmed: true });
    const vue = await (await call(x, R.mfaSummary, 'GET', '/api/users/me/security/mfa')).json();
    expect(vue.passkeys).toEqual([]);
    expect(JSON.stringify(vue)).not.toMatch(/public_key|credential|secret/i);
    expect((await call(x, R.pkItem, 'PATCH', `/api/users/me/security/mfa/passkeys/${pk.id}`, { name: 'pirate' }, { id: String(pk.id) })).status).toBe(404);
    expect((await sql`SELECT name FROM mfa_passkeys WHERE id = ${pk.id}`)[0].name).not.toBe('pirate');
    expect((await sql`SELECT recipient_user_id FROM notification_outbox WHERE event_type = 'MFA_SECURITY_EVENT' AND recipient_user_id NOT IN (${u.id}, ${autre.id}) AND created_at > now() - interval '5 minutes' AND payload_json::text LIKE '%passkey_added%'`).length).toBe(0);

    // Google / Apple + facteur : la preuve du fournisseur ne vaut pas MFA.
    const { checkSessionEligibility, openSocialSession } = await import('@/lib/auth/oauth/session-bridge');
    const el = await checkSessionEligibility(u.id);
    expect(el.ok).toBe(true);
    const g = new Appareil();
    const res = NextResponse.json({});
    const outcome = await openSocialSession(g.req('/api/auth/oauth/google/callback'), res, (el as unknown as { user: never }).user, 'google');
    g.absorb(res);
    expect(outcome).toMatchObject({ kind: 'mfa', step: 'challenge' });
    expect(g.jar.has('access_token')).toBe(false);
    const go = await (await call(g, R.pkOptions, 'POST', '/api/auth/mfa/passkey/options', { mode: 'pending' })).json();
    expect(go.options.allowCredentials.map((c: { id: string }) => c.id)).toEqual([Buffer.from(cred.id).toString('base64url')]);
    cred.counter = 0;
    expect((await call(g, R.pkVerify, 'POST', '/api/auth/mfa/passkey/verify', { mode: 'pending', challengeId: go.challengeId, response: authenticationResponse(cred, { challenge: go.options.challenge, rpId: go.options.rpId }, { origin: ORIGIN }) })).status).toBe(200);
    expect(await payloadOf(g)).toMatchObject({ aal: 2, amr: ['google', 'passkey'] });
    await obligation('users', null);
  });

  it('L110B-REC récupération : e-mail + code, sessions révoquées, code à usage unique, nouvel enrôlement', async () => {
    await obligation('users', hier());
    const u = await compte();
    const a = new Appareil();
    await connexion(a, u.email);
    const { codes } = await enrolerTotp(a);
    await call(a, R.codesConfirm, 'POST', '/api/auth/mfa/recovery-codes/confirm', { confirmed: true });
    expect((await call(a, R.me, 'GET', '/api/users/me')).status).toBe(200);

    // Adresse inconnue : même réponse (non énumérant).
    const n = new Appareil();
    const inconnu = await call(n, R.recStart, 'POST', '/api/auth/mfa/recovery/start', { email: 'personne@test.invalid' });
    const c = new Appareil();
    const connu = await call(c, R.recStart, 'POST', '/api/auth/mfa/recovery/start', { email: u.email });
    expect([inconnu.status, connu.status]).toEqual([200, 200]);
    expect(await inconnu.json()).toEqual(await connu.json());
    // Code e-mail connu du test (l'envoi réel est asynchrone) : même lien navigateur.
    const { storeEmailCode } = await import('@/lib/auth/mfa/challenges');
    await storeEmailCode(u.id, `rc:${c.jar.get('vb_mfa_rc')}`, '424242', 15 * 60_000);
    expect((await call(c, R.recVerify, 'POST', '/api/auth/mfa/recovery/verify', { email: u.email, emailCode: '424242', recoveryCode: 'AAAA-BBBB-CCCC-DDDD' })).status).toBe(401);
    await storeEmailCode(u.id, `rc:${c.jar.get('vb_mfa_rc')}`, '424242', 15 * 60_000);
    // Code de récupération seul, sans code e-mail : refusé.
    expect((await call(c, R.recVerify, 'POST', '/api/auth/mfa/recovery/verify', { email: u.email, emailCode: '000000', recoveryCode: codes[0] })).status).toBe(401);
    await storeEmailCode(u.id, `rc:${c.jar.get('vb_mfa_rc')}`, '424242', 15 * 60_000);
    const ok = await call(c, R.recVerify, 'POST', '/api/auth/mfa/recovery/verify', { email: u.email, emailCode: '424242', recoveryCode: codes[0].toLowerCase() });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ step: 'enroll' });
    expect(c.jar.has('access_token')).toBe(false);
    // Sessions à risque révoquées.
    expect((await call(a, R.me, 'GET', '/api/users/me')).status).toBe(401);
    expect((await call(a, R.refresh, 'POST', '/api/auth/refresh')).status).toBe(401);
    // Nouvel enrôlement → session ; alerte « code utilisé ».
    const st = await (await call(c, R.state, 'GET', '/api/auth/mfa/state')).json();
    expect(st).toMatchObject({ step: 'enroll', recovered: true });
    const s = await (await call(c, R.totpEnroll, 'POST', '/api/auth/mfa/totp/enroll', { stage: 'start' })).json();
    const conf = await call(c, R.totpEnroll, 'POST', '/api/auth/mfa/totp/enroll', { stage: 'confirm', code: await totpCode(s.secret) });
    expect(conf.status).toBe(200);
    expect((await call(c, R.codesConfirm, 'POST', '/api/auth/mfa/recovery-codes/confirm', { confirmed: true })).status).toBe(200);
    expect(await payloadOf(c)).toMatchObject({ aal: 2, amr: ['recovery', 'otp'] });
    expect((await outbox(u.id, ['recovery_used', 'totp_replaced'])).map((x) => x.payload_json.event)).toEqual(expect.arrayContaining(['recovery_used', 'totp_replaced']));
    // Le code utilisé ne resservira jamais (et les anciens codes ont été remplacés).
    const d = new Appareil();
    await call(d, R.recStart, 'POST', '/api/auth/mfa/recovery/start', { email: u.email });
    await storeEmailCode(u.id, `rc:${d.jar.get('vb_mfa_rc')}`, '515151', 15 * 60_000);
    expect((await call(d, R.recVerify, 'POST', '/api/auth/mfa/recovery/verify', { email: u.email, emailCode: '515151', recoveryCode: codes[1] })).status).toBe(401);
    await obligation('users', null);
  });

  it('L110B-ADM obligation administrateurs activable séparément (plus tôt)', async () => {
    await obligation('users', null);
    await obligation('admins', hier());
    const admin = await compte('ADMIN');
    const user = await compte();
    const a = new Appareil();
    expect(await connexion(a, admin.email)).toMatchObject({ mfaRequired: true, step: 'enroll' });
    const b = new Appareil();
    expect((await connexion(b, user.email)).mfaRequired).toBeUndefined();
    expect((await call(b, R.me, 'GET', '/api/users/me')).status).toBe(200);
    // Ancienne session d'un administrateur (promu après coup) : BO refusé tant que la MFA n'est pas faite.
    const promu = await compte();
    const c = new Appareil();
    await connexion(c, promu.email);
    await sql`UPDATE users SET role = 'ADMIN' WHERE id = ${promu.id}`;
    const { GET: adminUsers } = await import('@/app/api/admin/users/route');
    const r = await adminUsers(c.req('/api/admin/users'));
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('MFA_REQUIRED');
    await obligation('admins', null);
  });

  it('L110B-VOL / L110B-BO ajout volontaire avant activation (preuve primaire fraîche → session promue) ; réglage BO contrôlé', async () => {
    await obligation('users', null);
    await obligation('admins', null);
    const u = await compte();
    const a = new Appareil();
    const b = new Appareil();
    await connexion(a, u.email);
    await connexion(b, u.email);
    // Sans preuve fraîche : refus (une vieille session seule ne suffit pas).
    expect((await call(a, R.accountTotp, 'POST', '/api/users/me/security/mfa/totp', { stage: 'start' })).status).toBe(403);
    expect((await call(a, R.reauth, 'POST', '/api/users/me/security/reauth', { method: 'password', password: PASSWORD })).status).toBe(200);
    const s = await (await call(a, R.accountTotp, 'POST', '/api/users/me/security/mfa/totp', { stage: 'start' })).json();
    const conf = await call(a, R.accountTotp, 'POST', '/api/users/me/security/mfa/totp', { stage: 'confirm', code: await totpCode(s.secret) });
    expect(conf.status).toBe(200);
    expect((await conf.json()).recoveryCodes).toHaveLength(10);
    // Cette session est promue (niveau 2) ; l'autre appareil, de niveau 1, est désormais sous garde.
    expect(await payloadOf(a)).toMatchObject({ aal: 2, amr: ['otp'] });
    expect((await call(a, R.me, 'GET', '/api/users/me')).status).toBe(200);
    expect((await call(b, R.me, 'GET', '/api/users/me')).status).toBe(403);
    // Retrait de la DERNIÈRE méthode forte : refusé même avec une preuve forte.
    expect((await call(a, R.reauth, 'POST', '/api/users/me/security/reauth', { method: 'totp', code: await totpCode(s.secret, 30_000) })).status).toBe(200);
    const del = await call(a, R.accountTotp, 'DELETE', '/api/users/me/security/mfa/totp');
    expect(del.status).toBe(409);

    // BO : lecture sans valeur secrète ; activation exige « ACTIVER » ; journal BO.
    const admin = await compte('SUPER_ADMIN');
    const bo = new Appareil();
    await connexion(bo, admin.email);
    const g = await call(bo, R.opsMfa, 'GET', '/api/admin/ops/mfa');
    expect(g.status).toBe(200);
    const vue = await g.json();
    expect(vue.users).toMatchObject({ enforcedFrom: null, active: false });
    expect(JSON.stringify(vue)).not.toMatch(/MFA_ENCRYPTION_KEYS=|base64/);
    const future = new Date(Date.now() + 14 * 86_400_000).toISOString();
    expect((await call(bo, R.opsMfa, 'PUT', '/api/admin/ops/mfa', { scope: 'users', enforcedFrom: future })).status).toBe(400);
    expect((await call(bo, R.opsMfa, 'PUT', '/api/admin/ops/mfa', { scope: 'users', enforcedFrom: future, confirm: 'ACTIVER' })).status).toBe(200);
    expect((await (await call(bo, R.opsMfa, 'GET', '/api/admin/ops/mfa')).json()).users).toMatchObject({ scheduled: true, active: false });
    // Programmée (date future) : aucun effet avant la date.
    expect((await call(bo, R.me, 'GET', '/api/users/me')).status).toBe(200);
    expect((await call(bo, R.opsMfa, 'PUT', '/api/admin/ops/mfa', { scope: 'users', enforcedFrom: null })).status).toBe(200);
    const j = await sql`SELECT action_type FROM admin_audit_log WHERE admin_user_id = ${admin.id} AND action_type = 'MFA_ENFORCEMENT_UPDATE'`;
    expect(j.length).toBeGreaterThanOrEqual(1);
  });
});
