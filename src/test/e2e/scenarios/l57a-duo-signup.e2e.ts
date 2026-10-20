/**
 * Lot 57A — ticket P2 « Premium Duo : supprimer le parrainage du formulaire
 * d'inscription des invités », et volet Duo du ticket P0 e-mails (reprise du
 * rattachement après vérification, deux navigateurs). Base PostgreSQL 16
 * réelle, vraies routes et vraie page serveur `/signup`, Resend simulé.
 *
 * DUO-SIGNUP-E2E-01 parcours complet d'un invité sans compte (même
 *                   navigateur) : contexte Duo établi par le serveur,
 *                   inscription, e-mail de vérification, activation (contexte
 *                   Duo conservé : `duo=1`), rattachement au BON Duo.
 * DUO-SIGNUP-E2E-02 deux navigateurs : e-mail de vérification ouvert ailleurs,
 *                   sans jeton local → rattachement par l'adresse vérifiée.
 * DUO-SIGNUP-E2E-03 invitation utilisée, expirée, inconnue, abonnement
 *                   inactif : page explicite (jamais le formulaire classique
 *                   en silence) ; idem en pré-lancement.
 * DUO-SIGNUP-E2E-04 aucun rattachement à un autre Duo par manipulation :
 *                   jeton d'un autre Duo, adresse différente, plusieurs
 *                   invitations, aucune invitation, compte non vérifié.
 * DUO-SIGNUP-E2E-05 inscription classique non affectée (formulaire sans
 *                   contexte d'invitation ; parrainage inchangé côté API).
 */
import * as React from 'react';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { uid } from '../factories';

const APP = 'https://app.e2e.verebona.test';
const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  process.env.APP_URL = 'https://app.e2e.verebona.test';
  return { calls: [] as Array<{ to: string; html: string }>, n: 0 };
});
afterAll(() => { delete process.env.RESEND_API_KEY; delete process.env.SIGNUP_MODE; });

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string; html: string }) => {
        etat.calls.push(p);
        etat.n += 1;
        return { data: { id: `em_duo_${etat.n}` }, error: null };
      },
    };
  },
}));

// La page serveur est rendue en JSX classique (React global) hors de Next.
(globalThis as { React?: typeof React }).React = React;

const PASSWORD = 'InviteDuo1!x';
type WithCookies = Response & { cookies: { get(n: string): { value: string } | undefined } };

function req(path: string, init: { body?: unknown; cookie?: string; method?: string } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json', origin: APP, host: 'app.e2e.verebona.test',
    'x-forwarded-for': `93.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}.9`,
  };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`${APP}${path}`, {
    method: init.method ?? 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

scenario('L57A-DUO-SIGNUP', 'Inscription des invités Premium Duo sans parrainage', ({ sql, make }) => {
  beforeEach(async () => {
    delete process.env.SIGNUP_MODE;
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@preprod.verebona.fr', 'support@verebona.fr')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
  });

  async function cgvu(): Promise<string> {
    const [cur] = await sql<{ version_code: string }[]>`
      SELECT version_code FROM legal_document_versions WHERE document_type = 'CGVU' AND status = 'CURRENT' LIMIT 1`;
    if (cur) return cur.version_code;
    const code = `E2E-${uid('cgvu')}`;
    await sql`INSERT INTO legal_document_versions
      (document_type, version_code, title, status, change_summary, published_at, effective_at, html_content, sha256, permalink, html_storage_key)
      VALUES ('CGVU', ${code}, 'CGVU e2e', 'CURRENT', 'e2e', now(), now(), '<p>CGVU</p>', ${'0'.repeat(64)}, ${`/cgvu/${code}`}, ${`legal/${code}.html`})`;
    return code;
  }
  async function jeton(user: { id: number; email: string }, accountId: number | null) {
    const { generateAccessToken } = await import('@/lib/jwt');
    return generateAccessToken({
      id: user.id, email: user.email, role: 'USER' as never, planType: 'PREMIUM_DUO' as never, status: 'ACTIVE' as never,
      ...(accountId ? { currentAccountId: accountId } : {}), hasActiveAccount: true,
    });
  }
  /** Titulaire d'un Duo actif qui invite `email` ; renvoie le jeton d'invitation. */
  async function inviter(email: string) {
    // Lot 72D : Duo activé par le chemin réel (BO / Stripe), rattaché au COMPTE du titulaire.
    const acc = await make.account({ plan: 'premium_duo' });
    await sql`UPDATE users SET first_name = 'Camille', last_name = 'Durand', is_active = true, status = 'ACTIVE' WHERE id = ${acc.ownerUserId}`;
    const { applyPlanChange } = await import('@/lib/plan-enforcement');
    await applyPlanChange({
      accountId: acc.id, ownerUserId: acc.ownerUserId, oldPlanType: 'STANDARD', newPlanType: 'PREMIUM_DUO',
      newSubStatus: 'ACTIVE', newPremiumUntil: null, newMaxMembers: 2, source: 'e2e:l57a', sendEmails: false,
    });
    await make.asset(acc, { name: `DUO57-maison-${acc.id}` });
    const [d] = await sql<{ id: number }[]>`SELECT duo_account_id AS id FROM accounts WHERE id = ${acc.id}`;
    const [u] = await sql<{ id: number; email: string }[]>`SELECT id, email FROM users WHERE id = ${acc.ownerUserId}`;
    const { POST } = await import('@/app/api/duo/invitation/route');
    const res = await POST(req('/api/duo/invitation', { body: { email }, cookie: `access_token=${await jeton(u, acc.id)}` }));
    expect((await res.json()).emailStatus).toBe('accepted');
    const [row] = await sql<{ t: string }[]>`SELECT pending_invite_token AS t FROM duo_accounts WHERE id = ${d.id}`;
    return { duoId: d.id, token: row.t, ownerId: u.id, accountId: acc.id };
  }
  async function page(params: Record<string, string>) {
    const { default: SignupPage } = await import('@/app/(auth)/signup/page');
    return (await SignupPage({ searchParams: Promise.resolve(params) })) as { type: unknown; props: Record<string, unknown> };
  }
  async function inscrire(email: string, inviteToken?: string) {
    const { POST } = await import('@/app/api/users/route');
    const res = await POST(req('/api/users', {
      body: { email, password: PASSWORD, firstName: 'Inès', lastName: 'Invitée', acceptedTerms: true, termsVersion: await cgvu(), inviteToken },
    }));
    return { status: res.status, body: await res.json() };
  }
  async function activer(email: string) {
    await (await import('@/lib/auth/anti-enumeration')).settleDetachedAuthTasks();
    const mail = etat.calls.filter((c) => c.to === email).at(-1);
    const m = /href="([^"]*\/api\/auth\/verify-email\?token=[^"]+)"/.exec(mail?.html ?? '');
    expect(m, 'e-mail de vérification reçu').toBeTruthy();
    const { GET } = await import('@/app/api/auth/verify-email/route');
    const res = await GET(new NextRequest(m![1].replace(/&amp;/g, '&')));
    await (await import('@/lib/auth/anti-enumeration')).settleDetachedAuthTasks(); // e-mail de bienvenue
    return { location: res.headers.get('location') ?? '', access: (res as WithCookies).cookies.get('access_token')?.value };
  }
  async function rejoindre(access: string | undefined, body: Record<string, unknown>) {
    const { POST } = await import('@/app/api/duo/join/route');
    const res = await POST(req('/api/duo/join', { body, cookie: access ? `access_token=${access}` : undefined }));
    return { status: res.status, body: await res.json().catch(() => ({})), access: (res as WithCookies).cookies.get('access_token')?.value };
  }
  const membre = async (duoId: number, email: string) => (await sql<{ status: string }[]>`
    SELECT m.status FROM duo_memberships m JOIN users u ON u.id = m.user_id WHERE m.duo_id = ${duoId} AND u.email = ${email}`)[0]?.status;

  it('DUO-SIGNUP-E2E-01 — invité sans compte, même navigateur : contexte serveur, vérification, contexte conservé, bon Duo', async () => {
    const email = `${uid('ines')}@proton.me`;
    const inv = await inviter(email);
    const { SignupForm } = await import('@/app/(auth)/signup/SignupForm');
    const el = await page({ inviteToken: inv.token });
    expect(el.type).toBe(SignupForm);
    expect(el.props.invitation).toEqual({ kind: 'duo', ownerName: 'Camille Durand', inviteEmail: email });

    const r = await inscrire(email, inv.token);
    expect(r.status).toBe(201);
    const v = await activer(email);
    expect(v.location).toContain('status=success');
    expect(v.location).toContain('duo=1'); // contexte Duo conservé après vérification
    expect(v.access).toBeTruthy();
    const j = await rejoindre(v.access, { token: inv.token });
    expect(j.status).toBe(200);
    expect(await membre(inv.duoId, email)).toBe('ACTIVE');
    const [u] = await sql<{ id: number; plan_type: string }[]>`SELECT id, plan_type FROM users WHERE email = ${email}`;
    expect(u.plan_type).toBe('PREMIUM_DUO'); // copie d'affichage historique (lot 72D : aucun droit n'en dépend)
    // Lot 72D : accès RÉEL aux données du titulaire, sans compte personnel ni essai.
    expect(await sql`SELECT role, status FROM account_memberships WHERE account_id = ${inv.accountId} AND user_id = ${u.id}`)
      .toEqual([{ role: 'member', status: 'active' }]);
    expect(await sql`SELECT 1 FROM accounts WHERE owner_user_id = ${u.id}`).toHaveLength(0);
    const { GET: biens } = await import('@/app/api/assets/route');
    const vus = await biens(req('/api/assets', { method: 'GET', cookie: `access_token=${j.access}` }));
    expect(await vus.text()).toContain(`DUO57-maison-${inv.accountId}`);
    // Aucun parrainage enregistré pour l'invité.
    const ref = await sql`SELECT 1 FROM referral_events re JOIN users x ON x.id = re.referred_user_id WHERE x.email = ${email}`;
    expect(ref).toHaveLength(0);
  });

  it('DUO-SIGNUP-E2E-02 — deux navigateurs : rattachement par l’adresse vérifiée, sans jeton local', async () => {
    const email = `${uid('autre-nav')}@proton.me`;
    const inv = await inviter(email);
    expect((await inscrire(email, inv.token)).status).toBe(201);
    const v = await activer(email);
    expect(v.location).toContain('duo=1');
    const j = await rejoindre(v.access, { invitedEmail: true });
    expect(j.status).toBe(200);
    expect(await membre(inv.duoId, email)).toBe('ACTIVE');
  });

  it('DUO-SIGNUP-E2E-03 — invitation utilisée, expirée, inconnue, inactive : page explicite (aussi en pré-lancement)', async () => {
    const { SignupInvitationInvalid } = await import('@/app/(auth)/signup/SignupInvitationInvalid');
    const { GET } = await import('@/app/api/duo/join/route');
    // Utilisée.
    const email = `${uid('used')}@proton.me`;
    const inv = await inviter(email);
    await inscrire(email, inv.token);
    const v = await activer(email);
    expect((await rejoindre(v.access, { token: inv.token })).status).toBe(200);
    const g = await GET(new NextRequest(`${APP}/api/duo/join?token=${inv.token}`));
    expect(g.status).toBe(410);
    expect((await g.json()).error).toBe('USED_TOKEN');
    let el = await page({ inviteToken: inv.token });
    expect(el.type).toBe(SignupInvitationInvalid);
    expect(el.props).toMatchObject({ context: { kind: 'duo', state: 'used' }, allowClassicSignup: true });
    // Expirée.
    const inv2 = await inviter(`${uid('exp')}@proton.me`);
    await sql`UPDATE duo_accounts SET pending_invite_token_expires_at = now() - interval '1 day' WHERE id = ${inv2.duoId}`;
    el = await page({ inviteToken: inv2.token });
    expect(el.props).toMatchObject({ context: { kind: 'duo', state: 'expired' } });
    // Inconnue.
    el = await page({ inviteToken: 'jeton-inconnu-57a' });
    expect(el.type).toBe(SignupInvitationInvalid);
    expect(el.props).toMatchObject({ context: { kind: 'unknown', state: 'invalid' } });
    // Abonnement inactif.
    const inv3 = await inviter(`${uid('inact')}@proton.me`);
    await sql`UPDATE duo_accounts SET subscription_status = 'CANCELED' WHERE id = ${inv3.duoId}`;
    el = await page({ inviteToken: inv3.token });
    expect(el.props).toMatchObject({ context: { kind: 'duo', state: 'inactive' } });
    // Pré-lancement : message dédié, pas d'inscription sans invitation proposée.
    process.env.SIGNUP_MODE = 'prelaunch';
    el = await page({ inviteToken: inv2.token });
    expect(el.type).toBe(SignupInvitationInvalid);
    expect(el.props).toMatchObject({ context: { state: 'expired' }, allowClassicSignup: false });
    const inv4 = await inviter(`${uid('pre')}@proton.me`);
    el = await page({ inviteToken: inv4.token });
    expect(el.props.invitation).toMatchObject({ kind: 'duo' });
  });

  it('DUO-SIGNUP-E2E-04 — aucun rattachement à un autre Duo par manipulation', async () => {
    const a = `${uid('a')}@proton.me`;
    const b = `${uid('b')}@proton.me`;
    const invA = await inviter(a);
    const invB = await inviter(b);
    // Inscription avec le jeton d'un Duo destiné à une autre adresse : refusée.
    const x = await inscrire(`${uid('intrus')}@proton.me`, invA.token);
    expect(x.status).toBe(400);
    expect(x.body.code).toBe('INVITE_EMAIL_MISMATCH');
    // A, vérifié, tente le jeton du Duo de B : refus, aucune adhésion.
    await inscrire(a, invA.token);
    const va = await activer(a);
    const j = await rejoindre(va.access, { token: invB.token });
    expect(j.status).toBe(403);
    expect(j.body.error).toBe('INVITE_EMAIL_MISMATCH');
    expect(await membre(invB.duoId, a)).toBeUndefined();
    // Mode « adresse vérifiée » : seule l'invitation de SA propre adresse.
    expect((await rejoindre(va.access, { invitedEmail: true, duoId: invB.duoId })).status).toBe(200);
    expect(await membre(invA.duoId, a)).toBe('ACTIVE');
    expect(await membre(invB.duoId, a)).toBeUndefined();
    // Aucune invitation en attente : 404 explicite.
    const c = `${uid('c')}@proton.me`;
    await inscrire(c);
    const vc = await activer(c);
    expect((await rejoindre(vc.access, { invitedEmail: true })).body.error).toBe('NO_PENDING_INVITATION');
    // Deux invitations pour la même adresse : choix par le lien, jamais au hasard.
    const d = `${uid('d')}@proton.me`;
    await inviter(d);
    await inviter(d);
    await inscrire(d);
    const vd = await activer(d);
    expect((await rejoindre(vd.access, { invitedEmail: true })).body.error).toBe('MULTIPLE_INVITATIONS');
    // Compte non vérifié : aucune session, donc aucun rattachement.
    const e = `${uid('e')}@proton.me`;
    const invE = await inviter(e);
    await inscrire(e, invE.token);
    const { POST: login } = await import('@/app/api/auth/login/route');
    const l = await login(req('/api/auth/login', { body: { email: e, password: PASSWORD } }));
    expect((l as WithCookies).cookies.get('access_token')).toBeUndefined();
    expect((await rejoindre(undefined, { token: invE.token })).status).toBe(401);
  });

  it('DUO-SIGNUP-E2E-05 — inscription classique non affectée', async () => {
    const { SignupForm } = await import('@/app/(auth)/signup/SignupForm');
    const el = await page({});
    expect(el.type).toBe(SignupForm);
    expect(el.props.invitation).toBeUndefined();
    const email = `${uid('classique')}@gmail.com`;
    const r = await inscrire(email);
    expect(r.status).toBe(201);
    const v = await activer(email);
    expect(v.location).toContain('status=success');
    expect(v.location).not.toContain('duo=1');
  });
});
