/**
 * Cartes #876 / #879 — dispense CIBLÉE de l'obligation globale de double
 * authentification, posée par un ADMIN depuis la fiche compte, SANS
 * qualification Apple / Google (#879). PostgreSQL 16 réel (migration 2020),
 * VRAIES routes de connexion et de session. Acteur : ADMIN (pas SUPER_ADMIN).
 *
 *   C876-LOGIN   MFA globale active : l'identité de revue autorisée se
 *                connecte par e-mail + mot de passe depuis un appareil neuf,
 *                sans code, session de NIVEAU 1 (aucun faux AAL2), routes
 *                privées accessibles, renouvellement non promu ; mot de passe
 *                invalide refusé ; un client ordinaire reste soumis à la MFA ;
 *   C876-REVOKE  révocation : sessions coupées, nouvelle connexion soumise à la
 *                règle normale ; retrait de qualification idem ;
 *   C876-SCOPE   invité Duo non autorisé : aucune exemption héritée ; accès à
 *                un compte client réel : exemption suspendue ; changement de
 *                rôle : perdue ; facteur enrôlé : toujours exigé ;
 *   C876-BO      contrôles du service : compte facturé / administrateur /
 *                compte technique refusés ; droits Premium Duo durables sans
 *                facturation ; historique.
 */
import { expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';

const PASSWORD = 'MotDePasseE2e1!';
const ORIGIN = 'http://localhost:3000';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const COOKIES = ['access_token', 'refresh_token', 'vb_device', 'vb_mfa'];

type WithCookies = Response & { cookies: { get(n: string): { value: string } | undefined } };
let ipN = 1;
class Appareil {
  jar = new Map<string, string>();
  ip = `176.${(ipN++) % 250}.${Math.floor(Math.random() * 250)}.9`;
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  absorb(res: Response) {
    for (const n of COOKIES) {
      const v = (res as WithCookies).cookies.get(n)?.value;
      if (v === undefined) continue;
      if (v === '') this.jar.delete(n); else this.jar.set(n, v);
    }
    return res;
  }
  req(path: string, method = 'GET', body?: unknown) {
    return new NextRequest(`${ORIGIN}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': this.ip, 'user-agent': UA, ...(this.jar.size ? { cookie: this.cookie() } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}
async function call(app: Appareil, mod: string, method: string, path: string, body?: unknown) {
  const m = await import(/* @vite-ignore */ mod) as Record<string, (r: NextRequest) => Promise<Response>>;
  return app.absorb(await m[method](app.req(path, method, body)));
}
const R = { login: '@/app/api/auth/login/route', refresh: '@/app/api/auth/refresh/route', me: '@/app/api/users/me/route', assets: '@/app/api/assets/route' };

scenario('C876', 'Comptes de revue Apple / Google : exemption MFA ciblée', ({ sql, make }) => {
  async function identite(role = 'USER') {
    const email = `${uid('c876')}@test.invalid`;
    const u = await make.user({ email, role });
    await sql`UPDATE users SET password_hash = ${await bcrypt.hash(PASSWORD, 4)}, is_active = true, status = 'ACTIVE' WHERE id = ${u.id}`;
    return { ...u, email };
  }
  const obligation = async (from: Date | null) => {
    await sql`UPDATE mfa_enforcement_settings SET enforced_from = ${from ? from.toISOString() : null} WHERE scope = 'users'`;
    await sql`UPDATE mfa_enforcement_settings SET enforced_from = ${from ? from.toISOString() : null} WHERE scope = 'admins'`;
  };
  const hier = () => new Date(Date.now() - 86_400_000);
  const svc = () => import('@/services/admin/app-review.service');
  const payloadOf = async (app: Appareil) => (await import('@/lib/jwt')).verifyAccessToken(app.jar.get('access_token')!);
  const login = async (app: Appareil, email: string, password = PASSWORD) => call(app, R.login, 'POST', '/api/auth/login', { email, password });

  /** #879 : compte STANDARD (aucune qualification), dispense directe par un ADMIN. */
  async function compteDeRevue() {
    const admin = await identite('ADMIN');
    const owner = await identite();
    const acc = await make.account({ owner, plan: null });
    const s = await svc();
    await s.grantExemption(acc.id, owner.id, admin.id, 'Revue des stores — titulaire');
    return { admin, owner, acc };
  }

  it('C876-LOGIN : appareil neuf, e-mail + mot de passe, sans code, session AAL1, routes privées ; client ordinaire inchangé', async () => {
    await obligation(hier());
    const { owner, acc } = await compteDeRevue();
    const { mfaRequirementFor } = await import('@/lib/auth/mfa/policy');
    expect(await mfaRequirementFor(owner.id)).toMatchObject({ required: false, enforced: true, exempt: true, reviewKind: null });
    // Aucune qualification, aucune offre modifiée par la dispense.
    expect((await sql`SELECT app_review_kind, plan_type FROM accounts WHERE id = ${acc.id}`)[0]).toMatchObject({ app_review_kind: null });

    const tel = new Appareil();
    const mauvais = await login(tel, owner.email, 'MauvaisMotDePasse1!');
    expect(mauvais.status).toBe(401);
    expect(tel.jar.has('access_token')).toBe(false);

    const ok = await login(tel, owner.email);
    expect(ok.status).toBe(200);
    const b = await ok.json();
    expect(b.mfaRequired).toBeUndefined();
    expect(tel.jar.has('vb_mfa')).toBe(false);
    expect((await payloadOf(tel))?.aal).toBe(1);
    expect((await call(tel, R.me, 'GET', '/api/users/me')).status).toBe(200);
    expect((await call(tel, R.refresh, 'POST', '/api/auth/refresh')).status).toBe(200);
    expect((await payloadOf(tel))?.aal).toBe(1);
    expect((await call(tel, R.me, 'GET', '/api/users/me')).status).toBe(200);
    // Journal (écrit sans attente) : connexion exemptée tracée, niveau 1, store.
    let journal: { details: unknown }[] = [];
    for (let i = 0; i < 40 && !journal.length; i++) {
      journal = await sql<{ details: unknown }[]>`SELECT details FROM user_activity_log WHERE user_id = ${owner.id} AND activity_type = 'MFA_APP_REVIEW_EXEMPTION_APPLIED'`;
      if (!journal.length) await new Promise((r) => setTimeout(r, 25));
    }
    expect(journal.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(journal[0].details)).toMatch(/aal\W+1/);

    // Client ordinaire : soumis à la MFA (étape d'enrôlement, aucune session complète).
    const client = await identite();
    await make.account({ owner: client });
    const autre = new Appareil();
    const r = await (await login(autre, client.email)).json();
    expect(r).toMatchObject({ mfaRequired: true, step: 'enroll' });
    expect(autre.jar.has('access_token')).toBe(false);
    expect(acc.id).toBeGreaterThan(0);
  });

  it('C876-REVOKE : rétablissement → sessions coupées, règle normale ; qualification facultative SANS effet sur la dispense (#879)', async () => {
    await obligation(hier());
    const { admin, owner, acc } = await compteDeRevue();
    const tel = new Appareil();
    expect((await login(tel, owner.email)).status).toBe(200);
    expect((await call(tel, R.me, 'GET', '/api/users/me')).status).toBe(200);

    const s = await svc();
    const change = await s.revokeExemption(acc.id, owner.id, admin.id, 'Fin de la revue Google');
    expect(change.revokeSessionsOf).toEqual([owner.id]);
    // Sans même révoquer les sessions, la décision (sans cache) refuse déjà l'accès AAL1.
    const refus = await call(tel, R.me, 'GET', '/api/users/me');
    expect(refus.status).toBe(403);
    expect((await refus.json()).code).toBe('MFA_REQUIRED');
    const neuf = new Appareil();
    expect(await (await login(neuf, owner.email)).json()).toMatchObject({ mfaRequired: true });

    // Nouvelle dispense, puis qualification / retrait facultatifs : la dispense
    // n'en dépend pas (#879) — ni révoquée, ni élargie.
    await s.grantExemption(acc.id, owner.id, admin.id, 'Nouvelle revue Google');
    const { mfaRequirementFor } = await import('@/lib/auth/mfa/policy');
    expect((await mfaRequirementFor(owner.id)).exempt).toBe(true);
    await s.qualifyAccount(acc.id, 'GOOGLE', admin.id, 'Libellé compte de revue');
    expect(await mfaRequirementFor(owner.id)).toMatchObject({ exempt: true, reviewKind: 'GOOGLE' });
    const u = await s.unqualifyAccount(acc.id, admin.id, 'Compte de revue retiré');
    expect(u.revokeSessionsOf).toEqual([]);
    expect(await mfaRequirementFor(owner.id)).toMatchObject({ required: false, exempt: true, reviewKind: null });
    const ev = await sql<{ event: string; actor_id: number }[]>`SELECT event, actor_id FROM app_review_events WHERE account_id = ${acc.id} ORDER BY id`;
    expect(ev.map((e) => e.event)).toEqual(['EXEMPTION_GRANTED', 'EXEMPTION_REVOKED', 'EXEMPTION_GRANTED', 'ACCOUNT_QUALIFIED', 'ACCOUNT_UNQUALIFIED']);
    expect(ev.every((e) => Number(e.actor_id) === admin.id)).toBe(true);
  });

  it('C876-SCOPE : invité non autorisé, accès à un autre compte, statut / rôle changés, facteur enrôlé → aucune dispense', async () => {
    await obligation(hier());
    const { admin, owner, acc } = await compteDeRevue();
    const { mfaRequirementFor } = await import('@/lib/auth/mfa/policy');
    const s = await svc();

    // Invité Duo du compte de revue, non autorisé explicitement : rien n'est hérité.
    const invite = await identite();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${acc.id}, ${invite.id}, 'member', 'active')`;
    expect(await mfaRequirementFor(invite.id)).toMatchObject({ required: true, exempt: false });
    // Autorisé explicitement : exempté, confiné au compte de revue.
    await s.grantExemption(acc.id, invite.id, admin.id, 'Seconde identité Duo Apple');
    expect((await mfaRequirementFor(invite.id)).exempt).toBe(true);

    // Accès à un AUTRE compte (quel qu'il soit) : dispense suspendue aussitôt, et refusée à l'autorisation.
    const reel = await make.account();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${reel.id}, ${invite.id}, 'member', 'active')`;
    expect(await mfaRequirementFor(invite.id)).toMatchObject({ required: true, exempt: false });
    await s.revokeExemption(acc.id, invite.id, admin.id, 'Accès à un compte réel détecté');
    await expect(s.grantExemption(acc.id, invite.id, admin.id, 'Nouvelle tentative')).rejects.toMatchObject({ code: 'OTHER_ACCOUNT_ACCESS' });

    // Suspension : dispense perdue ; réactivation : retrouvée (la ligne n'a pas changé).
    await sql`UPDATE users SET status = 'SUSPENDED' WHERE id = ${owner.id}`;
    expect(await mfaRequirementFor(owner.id)).toMatchObject({ required: true, exempt: false });
    await sql`UPDATE users SET status = 'ACTIVE' WHERE id = ${owner.id}`;
    // Retrait de l'adhésion de l'invité au compte : dispense perdue (déjà révoquée ici) ;
    // le titulaire retiré de son compte : plus aucun droit actif.
    // Changement de rôle : exemption perdue (obligation administrateurs).
    await sql`UPDATE users SET role = 'ADMIN' WHERE id = ${owner.id}`;
    expect(await mfaRequirementFor(owner.id)).toMatchObject({ required: true, exempt: false });
    await sql`UPDATE users SET role = 'USER' WHERE id = ${owner.id}`;
    expect((await mfaRequirementFor(owner.id)).exempt).toBe(true);

    // Facteur enrôlé : toujours exigé.
    await sql`INSERT INTO user_mfa_state (user_id, enabled_at, last_method, updated_at) VALUES (${owner.id}, now(), 'totp', now())
              ON CONFLICT (user_id) DO UPDATE SET enabled_at = now()`;
    expect(await mfaRequirementFor(owner.id)).toMatchObject({ required: true, enrolled: true, exempt: false });

    // Obligation globale inactive : comportement inchangé pour un compte sans facteur.
    await sql`DELETE FROM user_mfa_state WHERE user_id = ${owner.id}`;
    await obligation(null);
    expect(await mfaRequirementFor(owner.id)).toMatchObject({ required: false, enforced: false, exempt: false });
  });

  it('C879-AVANT : dispense enregistrée AVANT l’activation globale → affichée « sans effet actuel », puis effective à l’activation', async () => {
    await obligation(null);
    const { owner, acc } = await compteDeRevue();
    const s = await svc();
    const client = await identite();
    await make.account({ owner: client });
    let view = await s.loadAppReviewView(acc.id);
    expect(view.mfaEnforcement.users).toBe(false);
    expect(view.users.find((u) => u.id === owner.id)).toMatchObject({ state: 'INACTIVE_POLICY', effective: false });
    expect(view.users.find((u) => u.id === owner.id)?.diagnostic).toMatch(/sans effet tant que l’obligation globale/);

    await obligation(hier());
    view = await s.loadAppReviewView(acc.id);
    expect(view.users.find((u) => u.id === owner.id)).toMatchObject({ state: 'EFFECTIVE', effective: true, diagnostic: null });
    const { mfaRequirementFor } = await import('@/lib/auth/mfa/policy');
    expect(await mfaRequirementFor(owner.id)).toMatchObject({ required: false, exempt: true });
    expect(await mfaRequirementFor(client.id)).toMatchObject({ required: true, exempt: false });
    // Deux comptes de revue distincts, non qualifiés : chacun sa dispense, aucune croisée.
    const second = await compteDeRevue();
    expect(await mfaRequirementFor(second.owner.id)).toMatchObject({ exempt: true });
    await expect(s.grantExemption(acc.id, second.owner.id, second.admin.id, 'Croisement interdit')).rejects.toMatchObject({ code: 'NO_ACCESS' });

    // Facteur enrôlé : « non effective », avec explication.
    await sql`INSERT INTO user_mfa_state (user_id, enabled_at, last_method, updated_at) VALUES (${owner.id}, now(), 'totp', now())
              ON CONFLICT (user_id) DO UPDATE SET enabled_at = now()`;
    view = await s.loadAppReviewView(acc.id);
    expect(view.users.find((u) => u.id === owner.id)).toMatchObject({ state: 'NOT_EFFECTIVE', mfaEnrolled: true });
    expect(view.users.find((u) => u.id === owner.id)?.diagnostic).toMatch(/ne dispense pas d’un facteur configuré/);
    await sql`DELETE FROM user_mfa_state WHERE user_id = ${owner.id}`;
  });

  it('C876-BO : refus (compte facturé, administrateur, technique, déjà qualifié) ; droits Premium Duo durables sans facturation, DISTINCTS de la dispense', async () => {
    await obligation(hier());
    const s = await svc();
    const admin = await identite('ADMIN');

    const facture = await make.account();
    await sql`UPDATE accounts SET stripe_customer_id = ${`cus_${uid('x')}`} WHERE id = ${facture.id}`;
    await expect(s.qualifyAccount(facture.id, 'APPLE', admin.id, 'Tentative sur compte facturé')).rejects.toMatchObject({ code: 'BILLED_ACCOUNT' });
    expect((await sql`SELECT app_review_kind FROM accounts WHERE id = ${facture.id}`)[0].app_review_kind).toBeNull();

    const adm = await identite('ADMIN');
    const accAdm = await make.account({ owner: adm, plan: null });
    await expect(s.qualifyAccount(accAdm.id, 'APPLE', admin.id, 'Tentative sur compte admin')).rejects.toMatchObject({ code: 'ADMIN_MEMBER' });

    const tech = await make.account({ plan: null });
    await sql`UPDATE accounts SET technical_kind = 'AI_QUALIFICATION_CORPUS' WHERE id = ${tech.id} AND NOT EXISTS (SELECT 1 FROM accounts WHERE technical_kind = 'AI_QUALIFICATION_CORPUS')`;
    const [t] = await sql`SELECT technical_kind FROM accounts WHERE id = ${tech.id}`;
    if (t.technical_kind) await expect(s.qualifyAccount(tech.id, 'GOOGLE', admin.id, 'Tentative sur compte technique')).rejects.toMatchObject({ code: 'TECHNICAL_ACCOUNT' });

    const owner = await identite();
    const acc = await make.account({ owner, plan: null });
    // #879 : dispense SANS qualification — n'attribue AUCUN droit ni offre.
    await s.grantExemption(acc.id, owner.id, admin.id, 'Dispense sans qualification');
    expect((await sql`SELECT plan_type, app_review_kind FROM accounts WHERE id = ${acc.id}`)[0]).toMatchObject({ app_review_kind: null });
    expect((await sql`SELECT plan_type FROM accounts WHERE id = ${acc.id}`)[0].plan_type).not.toBe('PREMIUM_DUO');
    await expect(s.grantDemoRights(acc.id, admin.id, 'Droits sans qualification')).rejects.toMatchObject({ code: 'NOT_QUALIFIED' });
    await s.qualifyAccount(acc.id, 'GOOGLE', admin.id, 'Compte de revue Google');
    await expect(s.qualifyAccount(acc.id, 'APPLE', admin.id, 'Autre store')).rejects.toMatchObject({ code: 'OTHER_QUALIFICATION' });
    await expect(s.grantExemption(acc.id, adm.id, admin.id, 'Administrateur')).rejects.toMatchObject({ code: 'ROLE_NOT_ELIGIBLE' });

    await s.grantDemoRights(acc.id, admin.id, 'Droits Premium Duo de démonstration');
    const [a] = await sql<{ plan_type: string; subscription_status: string; stripe_subscription_id: string | null }[]>`
      SELECT plan_type, subscription_status, stripe_subscription_id FROM accounts WHERE id = ${acc.id}`;
    expect(a).toEqual({ plan_type: 'PREMIUM_DUO', subscription_status: 'ACTIVE', stripe_subscription_id: null });
    const { getEntitlements } = await import('@/services/entitlements.service');
    const e = await getEntitlements(acc.id, new Date(Date.now() + 365 * 86_400_000));
    expect(e).toMatchObject({ plan: 'premium_duo', premiumFeatures: true, canWrite: true, isRestricted: false });
    expect(e.quotas.maxUsers).toBe(2);

    const view = await s.loadAppReviewView(acc.id);
    expect(view.account).toMatchObject({ kind: 'GOOGLE', kindLabel: 'Compte de revue Google', billed: false });
    expect(view.events.map((x) => x.event)).toEqual(['DEMO_RIGHTS_GRANTED', 'ACCOUNT_QUALIFIED', 'EXEMPTION_GRANTED']);
    // Comptes clients existants : inchangés (qualification NULL).
    expect((await sql`SELECT COUNT(*)::int AS n FROM accounts WHERE app_review_kind IS NOT NULL AND id <> ${acc.id} AND id NOT IN (
      SELECT account_id FROM app_review_events WHERE event = 'ACCOUNT_QUALIFIED')`)[0].n).toBe(0);
  });
});
