/**
 * Lot 72 (72D) — ticket P0 « Premium Duo — Unifier utilisateurs/comptes et
 * corriger le partage réel », sur PostgreSQL 16 réel, VRAIES routes (aucune
 * adhésion fabriquée en SQL : inscription, vérification d'adresse,
 * invitation, acceptation, connexion, changement d'espace passent par les
 * handlers Next). Seule l'activation de l'offre Duo du titulaire passe par
 * `applyPlanChange` (chemin réel du BO et des webhooks Stripe) : Stripe n'est
 * pas joignable en e2e.
 *
 * Identifiants L72D-xx = scénarios du §8 du ticket (+ L72D-00 : faille
 * d'invitation dans un compte tiers, trouvée à l'audit).
 */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { uid } from '../factories';

const APP = 'https://app.e2e.verebona.test';
const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  process.env.APP_URL = 'https://app.e2e.verebona.test';
  return { calls: [] as Array<{ to: string; html: string; subject?: string }>, n: 0 };
});
afterAll(() => { delete process.env.RESEND_API_KEY; });

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string; html: string; subject?: string }) => {
        etat.calls.push(p);
        etat.n += 1;
        return { data: { id: `em_l72d_${etat.n}` }, error: null };
      },
    };
  },
}));

const PASSWORD = 'MembreDuo1!x';
type WithCookies = Response & { cookies: { get(n: string): { value: string } | undefined } };

function req(path: string, init: { body?: unknown; cookie?: string; method?: string } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json', origin: APP, host: 'app.e2e.verebona.test',
    'x-forwarded-for': `94.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}.7`,
  };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`${APP}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const ck = (access?: string) => (access ? `access_token=${access}` : undefined);
const params = (p: Record<string, string | number>): { params: Promise<any> } => ({
  params: Promise.resolve(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]))),
});

async function claims(access: string | undefined) {
  if (!access) return null;
  const { verifyAccessToken } = await import('@/lib/jwt');
  return verifyAccessToken(access);
}

scenario('L72D', 'Premium Duo en compte partagé', ({ sql, make }) => {
  beforeEach(async () => {
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

  // ── Parcours réels ────────────────────────────────────────────────────
  async function inscrire(email: string, inviteToken?: string) {
    const { POST } = await import('@/app/api/users/route');
    const res = await POST(req('/api/users', {
      body: { email, password: PASSWORD, firstName: 'Inès', lastName: 'Invitée', acceptedTerms: true, termsVersion: await cgvu(), inviteToken },
    }));
    return { status: res.status, body: await res.json() };
  }
  async function activer(email: string) {
    await (await import('@/lib/auth/anti-enumeration')).settleDetachedAuthTasks();
    const mail = etat.calls.filter((c) => c.to === email && /verify-email\?token=/.test(c.html)).at(-1);
    const m = /href="([^"]*\/api\/auth\/verify-email\?token=[^"]+)"/.exec(mail?.html ?? '');
    expect(m, `e-mail de vérification reçu par ${email}`).toBeTruthy();
    const { GET } = await import('@/app/api/auth/verify-email/route');
    const res = await GET(new NextRequest(m![1].replace(/&amp;/g, '&')));
    await (await import('@/lib/auth/anti-enumeration')).settleDetachedAuthTasks();
    return { location: res.headers.get('location') ?? '', access: (res as WithCookies).cookies.get('access_token')?.value };
  }
  async function connecter(email: string) {
    const { POST } = await import('@/app/api/auth/login/route');
    const res = await POST(req('/api/auth/login', { body: { email, password: PASSWORD } }));
    return { status: res.status, access: (res as WithCookies).cookies.get('access_token')?.value };
  }
  async function rejoindre(access: string | undefined, body: Record<string, unknown>) {
    const { POST } = await import('@/app/api/duo/join/route');
    const res = await POST(req('/api/duo/join', { body, cookie: ck(access) }));
    return {
      status: res.status,
      body: await res.clone().json().catch(() => ({})) as Record<string, unknown>,
      access: (res as WithCookies).cookies.get('access_token')?.value,
    };
  }
  /** Jeton d'un titulaire créé par la fabrique (mot de passe non connectable). */
  async function jeton(user: { id: number; email: string }, accountId: number | null) {
    const { generateAccessToken } = await import('@/lib/jwt');
    return generateAccessToken({
      id: user.id, email: user.email, role: 'USER' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never,
      ...(accountId ? { currentAccountId: accountId } : {}), hasActiveAccount: true,
    });
  }

  /** Titulaire d'un Premium Duo ACTIF (activation par le chemin réel du BO/Stripe), avec des données. */
  async function duoActif(m = 'DUO') {
    const owner = await make.user({ email: `${uid('titulaire')}@proton.me` });
    await sql`UPDATE users SET first_name = 'Camille', last_name = 'Durand', is_active = true WHERE id = ${owner.id}`;
    const acc = await make.account({ owner, plan: 'premium_duo', name: `Compte de Camille Durand ${m}` });
    const { applyPlanChange } = await import('@/lib/plan-enforcement');
    await applyPlanChange({
      accountId: acc.id, ownerUserId: owner.id, oldPlanType: 'STANDARD', newPlanType: 'PREMIUM_DUO',
      newSubStatus: 'ACTIVE', newPremiumUntil: null, newMaxMembers: 2, source: 'e2e:l72d', sendEmails: false,
    });
    const [{ duo_account_id: duoId }] = await sql<{ duo_account_id: number }[]>`SELECT duo_account_id FROM accounts WHERE id = ${acc.id}`;
    const bien = await make.asset(acc, { category: 'IMMOBILIER', name: `${m}-maison-${acc.id}` });
    const doc = await make.assetFile(acc, { assetId: bien.id, name: `${m}-facture.pdf` });
    await sql`UPDATE asset_files SET upload_status = 'COMPLETED', document_type = 'FACTURE', original_filename = ${`${m}-facture.pdf`} WHERE id = ${doc.id}`;
    const [evt] = await sql<{ id: number }[]>`
      INSERT INTO events (account_id, user_id, asset_id, categorie, titre, date_evenement)
      VALUES (${acc.id}, ${owner.id}, ${bien.id}, 'entretien', ${`${m}-entretien`}, now()) RETURNING id`;
    const tok = await jeton(owner, acc.id);
    return { owner, acc, duoId, bien, doc, evt: evt.id, tok };
  }
  async function inviterDuo(tokTitulaire: string, email: string, duoId: number) {
    const { POST } = await import('@/app/api/duo/invitation/route');
    const res = await POST(req('/api/duo/invitation', { body: { email }, cookie: ck(tokTitulaire) }));
    expect(res.status, await res.clone().text()).toBe(200);
    const [row] = await sql<{ t: string }[]>`SELECT pending_invite_token AS t FROM duo_accounts WHERE id = ${duoId}`;
    return row.t;
  }
  /** Invité sans compte : inscription, vérification, acceptation. */
  async function nouvelInvite(d: Awaited<ReturnType<typeof duoActif>>, prefix = 'ines') {
    const email = `${uid(prefix)}@proton.me`;
    const token = await inviterDuo(d.tok, email, d.duoId);
    expect((await inscrire(email, token)).status).toBe(201);
    const v = await activer(email);
    const j = await rejoindre(v.access, { token });
    const [u] = await sql<{ id: number }[]>`SELECT id FROM users WHERE email = ${email}`;
    return { email, token, v, j, user: { id: u.id, email } };
  }

  async function listeBiens(access: string | undefined) {
    const { GET } = await import('@/app/api/assets/route');
    const r = await GET(req('/api/assets', { cookie: ck(access) }));
    return { status: r.status, text: await r.text() };
  }
  const adhesion = async (accountId: number, userId: number) => (await sql<{ role: string; status: string }[]>`
    SELECT role, status FROM account_memberships WHERE account_id = ${accountId} AND user_id = ${userId}`)[0];

  // ── L72D-00 : faille d'invitation (audit §1.4) ─────────────────────────
  it('L72D-00a — un utilisateur quelconque ne peut pas inviter dans le compte d’un tiers', async () => {
    const d = await duoActif('FAILLE');
    const intrus = await make.account({ plan: 'standard' });
    const tokIntrus = await jeton(intrus.owner, intrus.id);
    const { POST } = await import('@/app/api/accounts/[accountId]/members/invite/route');
    const cible = `${uid('complice')}@proton.me`;
    const r = await POST(req(`/api/accounts/${d.acc.id}/members/invite`, { body: { email: cible }, cookie: ck(tokIntrus) }), params({ accountId: d.acc.id }));
    expect(r.status).toBe(403);
    expect(await sql`SELECT 1 FROM account_memberships WHERE account_id = ${d.acc.id} AND invited_email = ${cible}`).toHaveLength(0);
    // Même un membre (non titulaire) du compte ne peut pas inviter.
    const membre = await nouvelInvite(d, 'membre-faille');
    expect(membre.j.status).toBe(200);
    const m = await connecter(membre.email);
    const r2 = await POST(req(`/api/accounts/${d.acc.id}/members/invite`, { body: { email: cible }, cookie: ck(m.access) }), params({ accountId: d.acc.id }));
    expect(r2.status).toBe(403);
  });

  it('L72D-00b — réinvitation d’un ancien membre retiré : adhésion réactivée (plus de 500)', async () => {
    const titulaire = await make.account({ plan: 'premium_duo' });
    await sql`UPDATE accounts SET plan_type = 'PREMIUM_DUO', max_members = 3 WHERE id = ${titulaire.id}`;
    const ancien = await make.account({ plan: 'standard' });
    const tokT = await jeton(titulaire.owner, titulaire.id);
    const { POST } = await import('@/app/api/accounts/[accountId]/members/invite/route');
    const inviter = () => POST(req(`/api/accounts/${titulaire.id}/members/invite`, { body: { email: ancien.owner.email }, cookie: ck(tokT) }), params({ accountId: titulaire.id }));
    const r1 = await inviter();
    expect(r1.status, await r1.clone().text()).toBe(200);
    const { AccountService } = await import('@/services/account-service');
    const [p] = await sql<{ invite_token: string }[]>`SELECT invite_token FROM account_memberships WHERE account_id = ${titulaire.id} AND user_id = ${ancien.owner.id}`;
    expect((await AccountService.acceptInvite(p.invite_token, ancien.owner.id)).success).toBe(true);
    const [m] = await sql<{ id: number }[]>`SELECT id FROM account_memberships WHERE account_id = ${titulaire.id} AND user_id = ${ancien.owner.id}`;
    const { DELETE } = await import('@/app/api/accounts/[accountId]/members/[membershipId]/route');
    expect((await DELETE(req(`/api/accounts/${titulaire.id}/members/${m.id}`, { method: 'DELETE', cookie: ck(tokT) }), params({ accountId: titulaire.id, membershipId: m.id }))).status).toBe(200);
    const r2 = await inviter();
    expect(r2.status, await r2.clone().text()).toBe(200);
    const lignes = await sql<{ id: number; status: string }[]>`SELECT id, status FROM account_memberships WHERE account_id = ${titulaire.id} AND user_id = ${ancien.owner.id}`;
    expect(lignes).toEqual([{ id: m.id, status: 'pending' }]);
  });

  // ── Cœur du P0 ─────────────────────────────────────────────────────────
  it('L72D-02 — nouvel invité : identité créée, aucun compte personnel, aucun essai, aucun parrainage', async () => {
    const d = await duoActif('NOUVEL');
    const inv = await nouvelInvite(d);
    expect(inv.v.location).toContain('status=success');
    expect(await sql`SELECT 1 FROM accounts WHERE owner_user_id = ${inv.user.id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM account_memberships WHERE user_id = ${inv.user.id} AND role = 'owner'`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM trial_grants WHERE email_normalized = ${inv.email}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM account_subscriptions s JOIN account_memberships m ON m.account_id = s.account_id
                     WHERE m.user_id = ${inv.user.id} AND s.status = 'trialing'`).toHaveLength(0);
    // Preuve d'acceptation des CGU enregistrée malgré l'absence de compte.
    expect(await sql`SELECT 1 FROM legal_acceptances WHERE user_id = ${inv.user.id}`).toHaveLength(1);
  });

  it('L72D-03 — invitation acceptée : adhésion member au compte EXISTANT, session ouverte sur ce compte', async () => {
    const d = await duoActif('ACCEPTE');
    const inv = await nouvelInvite(d);
    expect(inv.j.status).toBe(200);
    expect(await adhesion(d.acc.id, inv.user.id)).toEqual({ role: 'member', status: 'active' });
    // Double écriture historique conservée pendant la transition.
    expect((await sql<{ status: string }[]>`SELECT status FROM duo_memberships WHERE duo_id = ${d.duoId} AND user_id = ${inv.user.id}`)[0]?.status).toBe('ACTIVE');
    // Session réémise sur le compte Duo.
    expect((await claims(inv.j.access))?.currentAccountId).toBe(d.acc.id);
    // Titulaire rattaché techniquement comme owner (L72D-01).
    expect(await adhesion(d.acc.id, d.owner.id)).toEqual({ role: 'owner', status: 'active' });
  });

  it('L72D-05 — le membre voit les biens, documents et échéances du titulaire', async () => {
    const d = await duoActif('PARTAGE');
    const inv = await nouvelInvite(d);
    const biens = await listeBiens(inv.j.access);
    expect(biens.status).toBe(200);
    expect(biens.text).toContain(`PARTAGE-maison-${d.acc.id}`);
    const { GET: evenements } = await import('@/app/api/events/route');
    expect(await (await evenements(req('/api/events', { cookie: ck(inv.j.access) }))).text()).toContain('PARTAGE-entretien');
  });

  // ── Aides supplémentaires ────────────────────────────────────────────
  async function moi(access: string | undefined) {
    const { GET } = await import('@/app/api/users/me/route');
    const r = await GET(req('/api/users/me', { cookie: ck(access) }));
    return { status: r.status, body: await r.json() as Record<string, any> };
  }
  async function droits(access: string | undefined) {
    const { GET } = await import('@/app/api/billing/trial-status/route');
    const r = await GET(req('/api/billing/trial-status', { cookie: ck(access) }));
    return { status: r.status, body: await r.json() as Record<string, any> };
  }
  async function changerEspace(access: string | undefined, accountId: number) {
    const { POST } = await import('@/app/api/auth/switch-account/route');
    const r = await POST(req('/api/auth/switch-account', { body: { accountId }, cookie: ck(access) }));
    return { status: r.status, body: await r.json().catch(() => ({})), access: (r as WithCookies).cookies.get('access_token')?.value };
  }
  /** Utilisateur déjà inscrit (inscription classique réelle, compte personnel + essai), avec un bien. */
  async function inscritClassique(prefix: string, opts: { bien?: boolean } = {}) {
    const email = `${uid(prefix)}@proton.me`;
    expect((await inscrire(email)).status).toBe(201);
    const v = await activer(email);
    expect(v.access).toBeTruthy();
    const perso = (await claims(v.access))!.currentAccountId!;
    if (opts.bien !== false) {
      const { POST } = await import('@/app/api/assets/route');
      const r = await POST(req('/api/assets', { body: { name: `${prefix}-perso-velo`, category: 'VEHICULE' }, cookie: ck(v.access) }));
      expect(r.status, await r.clone().text()).toBe(201);
    }
    const [u] = await sql<{ id: number }[]>`SELECT id FROM users WHERE email = ${email}`;
    return { email, user: { id: u.id, email }, perso, access: v.access };
  }

  it('L72D-01 — inscription classique : le titulaire est rattaché techniquement à son compte comme owner', async () => {
    const e = await inscritClassique('titulaire-classique');
    const [m] = await sql<{ role: string; status: string; source: string | null }[]>`
      SELECT role, status, source FROM account_memberships WHERE account_id = ${e.perso} AND user_id = ${e.user.id}`;
    expect(m).toEqual({ role: 'owner', status: 'active', source: 'signup' });
  });

  it('L72D-04 — connexion : le bon compte s’ouvre (dernier espace choisi encore accessible)', async () => {
    const d = await duoActif('CONNEXION');
    const inv = await nouvelInvite(d);
    const l = await connecter(inv.email);
    expect(l.status).toBe(200);
    expect((await claims(l.access))?.currentAccountId).toBe(d.acc.id);
    // Utilisateur déjà inscrit : après acceptation le Duo s'ouvre ; après
    // retour volontaire à son espace, c'est lui qui s'ouvre à la connexion.
    const e = await inscritClassique('existant-cnx');
    const token = await inviterDuo((await duoActif('CNX2')).tok, e.email, (await sql<{ id: number }[]>`SELECT max(id) AS id FROM duo_accounts`)[0].id);
    const j = await rejoindre(e.access, { token });
    expect(j.status).toBe(200);
    const duoAcc = j.body.accountId as number;
    expect((await claims((await connecter(e.email)).access))?.currentAccountId).toBe(duoAcc);
    const sw = await changerEspace(j.access, e.perso);
    expect(sw.status).toBe(200);
    expect((await claims((await connecter(e.email)).access))?.currentAccountId).toBe(e.perso);
  });

  it('L72D-06 — modifications et suppressions métier accessibles au titulaire ET au membre', async () => {
    const d = await duoActif('ECRIT');
    const inv = await nouvelInvite(d);
    const m = inv.j.access;
    const { PUT, POST } = await import('@/app/api/assets/route');
    // Le membre modifie un bien créé par le titulaire.
    const r1 = await PUT(req(`/api/assets?id=${d.bien.id}`, { method: 'PUT', body: { name: 'ECRIT-maison-renommee' }, cookie: ck(m) }));
    expect(r1.status, await r1.clone().text()).toBe(200);
    // Il modifie un document déposé par le titulaire (le filtre « créateur » est retiré).
    const { PUT: majDoc } = await import('@/app/api/documents/[id]/route');
    const r2 = await majDoc(req(`/api/documents/${d.doc.id}`, { method: 'PUT', body: { fileName: 'ECRIT-facture.pdf', documentType: 'FACTURE', retainedTitle: 'Facture modifiée par le membre' }, cookie: ck(m) }), params({ id: d.doc.id }));
    expect(r2.status, await r2.clone().text()).toBe(200);
    // Il supprime un événement du titulaire.
    const { DELETE: supprEvt } = await import('@/app/api/events/route');
    const r3 = await supprEvt(req(`/api/events?id=${d.evt}`, { method: 'DELETE', cookie: ck(m) }));
    expect(r3.status, await r3.clone().text()).toBeLessThan(300);
    // Il crée un bien ; le titulaire le modifie.
    const cree = await POST(req('/api/assets', { body: { name: 'ECRIT-velo-du-membre', category: 'VEHICULE' }, cookie: ck(m) }));
    expect(cree.status).toBe(201);
    const { id: bienMembre } = await cree.json() as { id: number };
    const r4 = await PUT(req(`/api/assets?id=${bienMembre}`, { method: 'PUT', body: { name: 'ECRIT-velo-renomme' }, cookie: ck(d.tok) }));
    expect(r4.status).toBe(200);
    // Le membre supprime (corbeille) le document du titulaire.
    const { POST: bulk } = await import('@/app/api/documents/bulk-delete/route');
    const r5 = await bulk(req('/api/documents/bulk-delete', { body: { documentIds: [d.doc.id] }, cookie: ck(m) }));
    expect(r5.status, await r5.clone().text()).toBe(200);
    expect((await sql`SELECT 1 FROM asset_files WHERE id = ${d.doc.id} AND deleted_at IS NOT NULL`)).toHaveLength(1);
  });

  it('L72D-07 — le membre n’a aucun accès Stripe, facturation, membres ni administration du compte', async () => {
    const d = await duoActif('STRIPE');
    const inv = await nouvelInvite(d);
    const m = ck(inv.j.access);
    const appel = async (path: string, method = 'POST', body: unknown = {}) => {
      const mod = await import(`@/app/api/${path}/route`) as Record<string, (r: NextRequest, c?: unknown) => Promise<Response>>;
      const r = await mod[method](req(`/api/${path}`, { method, body: method === 'DELETE' ? undefined : body, cookie: m }));
      return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
    };
    expect((await appel('billing/upgrade', 'POST', { plan_code: 'premium', billing_period: 'yearly' })).status).toBe(403);
    expect((await appel('billing/cancel-subscription')).status).toBe(403);
    expect((await appel('billing/sync-subscription')).status).toBe(403);
    const portail = await appel('billing/create-customer-portal-session');
    expect(portail.status).toBe(403);
    expect(portail.body.code).toBe('DUO_GUEST');
    expect((await appel('billing/schedule-change', 'POST', { plan_code: 'premium', billing_period: 'monthly' })).status).toBe(403);
    expect((await appel('referral/me')).status).toBe(403);
    expect((await appel('account/calendar-token')).status).toBe(403);
    expect((await appel('duo/invitation', 'POST', { email: `${uid('x')}@proton.me` })).status).toBe(404);
    expect((await appel('duo/member', 'DELETE')).status).toBe(404);
    const { PUT } = await import('@/app/api/accounts/[accountId]/route');
    expect((await PUT(req(`/api/accounts/${d.acc.id}`, { method: 'PUT', body: { name: 'pirate' }, cookie: m }), params({ accountId: d.acc.id }))).status).toBe(403);
    // Écran « Mon abonnement » du membre : ni prix ni essai, titulaire nommé.
    const t = await droits(inv.j.access);
    expect(t.body.viewer).toEqual({ role: 'member', ownerName: 'Camille Durand' });
    expect(t.body.subscription.currentPrice).toBeNull();
    expect(t.body.trial.status).toBe('none');
  });

  it('L72D-08 — « Premium Duo — Membre », droits maintenus après J+7, jamais de fin d’essai', async () => {
    const d = await duoActif('J7');
    const inv = await nouvelInvite(d);
    const me = await moi(inv.j.access);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      accountId: d.acc.id, accountRole: 'member', duoRole: 'MEMBER', effectivePlan: 'PREMIUM_DUO',
      subscription: { plan: 'PREMIUM_DUO', trialStatus: 'none', isTrial: false },
    });
    const { getPlanLabel } = await import('@/lib/plan-label');
    expect(getPlanLabel({ plan: me.body.subscription.plan, duoRole: me.body.duoRole, trialStatus: me.body.subscription.trialStatus })).toBe('Premium Duo — Membre');
    // J+8 : la fin des essais passe, rien ne change pour le membre.
    const { runTrialExpiry } = await import('@/services/trial-expiry.job');
    await runTrialExpiry(new Date(Date.now() + 8 * 24 * 3600 * 1000));
    const t = await droits(inv.j.access);
    expect(t.body).toMatchObject({ plan: 'premium_duo', canWrite: true, isRestricted: false });
    expect(await sql`SELECT 1 FROM notification_outbox WHERE recipient_user_id = ${inv.user.id} AND event_type IN ('TRIAL_ENDED', 'TRIAL_ENDING')`).toHaveLength(0);
  });

  it('L72D-09 — quotas communs au compte, jamais multipliés par le nombre de membres', async () => {
    const d = await duoActif('QUOTA');
    const inv = await nouvelInvite(d);
    const avant = await droits(d.tok);
    const vuMembre = await droits(inv.j.access);
    expect(vuMembre.body.quotas).toEqual(avant.body.quotas);
    const { POST } = await import('@/app/api/assets/route');
    expect((await POST(req('/api/assets', { body: { name: 'QUOTA-moto', category: 'VEHICULE' }, cookie: ck(inv.j.access) }))).status).toBe(201);
    const apres = await droits(d.tok);
    expect(apres.body.quotas.assets.used).toBe(avant.body.quotas.assets.used + 1);
    expect(apres.body.quotas.assets.limit).toBe(avant.body.quotas.assets.limit);
    const { GET: quota } = await import('@/app/api/files/quota/route');
    const qm = await (await quota(req('/api/files/quota', { cookie: ck(inv.j.access) }))).json() as { accountId: number; totalFiles: number };
    const qt = await (await quota(req('/api/files/quota', { cookie: ck(d.tok) }))).json() as { accountId: number; totalFiles: number };
    expect(qm).toMatchObject({ accountId: d.acc.id, totalFiles: qt.totalFiles });
  });

  it('L72D-10 — utilisateur déjà inscrit : comptes distincts préservés, changement d’espace sans mélange', async () => {
    const d = await duoActif('EXIST');
    const e = await inscritClassique('deja-inscrit');
    const essaiAvant = await sql`SELECT status, trial_ends_at FROM account_subscriptions WHERE account_id = ${e.perso}`;
    const token = await inviterDuo(d.tok, e.email, d.duoId);
    const j = await rejoindre(e.access, { token });
    expect(j.status).toBe(200);
    expect((await claims(j.access))?.currentAccountId).toBe(d.acc.id);
    const surDuo = await listeBiens(j.access);
    expect(surDuo.text).toContain(`EXIST-maison-${d.acc.id}`);
    expect(surDuo.text).not.toContain('deja-inscrit-perso-velo');
    const { GET: espaces } = await import('@/app/api/accounts/route');
    const liste = await (await espaces(req('/api/accounts', { cookie: ck(j.access) }))).json() as { accounts: Array<{ id: number; role: string; plan: string; current: boolean }> };
    expect(liste.accounts.map((a) => [a.id, a.role, a.current])).toEqual([[e.perso, 'owner', false], [d.acc.id, 'member', true]]);
    expect(liste.accounts.find((a) => a.id === d.acc.id)?.plan).toBe('Premium Duo — Membre');
    const sw = await changerEspace(j.access, e.perso);
    expect(sw.status).toBe(200);
    const surPerso = await listeBiens(sw.access);
    expect(surPerso.text).toContain('deja-inscrit-perso-velo');
    expect(surPerso.text).not.toContain(`EXIST-maison-${d.acc.id}`);
    // Compte, essai et données personnels intacts.
    expect(await sql`SELECT status, trial_ends_at FROM account_subscriptions WHERE account_id = ${e.perso}`).toEqual(essaiAvant);
    expect((await moi(sw.access)).body).toMatchObject({ accountId: e.perso, accountRole: 'owner', duoRole: null, accountsCount: 2 });
  });

  it('L72D-11 — aucun accès aux données d’un compte étranger (identifiant client sans effet)', async () => {
    const d = await duoActif('ETRANGER');
    const inv = await nouvelInvite(d);
    const autre = await duoActif('AUTRE');
    const sw = await changerEspace(inv.j.access, autre.acc.id);
    expect(sw.status).toBe(403);
    expect(sw.access).toBeUndefined();
    expect((await listeBiens(await jeton(inv.user, autre.acc.id))).status).toBe(401);
    expect((await listeBiens(inv.j.access)).text).not.toContain('AUTRE-maison');
  });

  it('L72D-12 — invitations expirées, annulées ou concurrentes : aucun accès indu', async () => {
    // Expirée.
    const d = await duoActif('EXPIRE');
    const email = `${uid('exp')}@proton.me`;
    const token = await inviterDuo(d.tok, email, d.duoId);
    expect((await inscrire(email, token)).status).toBe(201);
    const v = await activer(email);
    await sql`UPDATE duo_accounts SET pending_invite_token_expires_at = now() - interval '1 day' WHERE id = ${d.duoId}`;
    expect((await rejoindre(v.access, { token })).status).toBe(410);
    const [u] = await sql<{ id: number }[]>`SELECT id FROM users WHERE email = ${email}`;
    expect(await sql`SELECT 1 FROM account_memberships WHERE user_id = ${u.id}`).toHaveLength(0);
    // Annulée par le titulaire.
    const d2 = await duoActif('ANNULE');
    const email2 = `${uid('ann')}@proton.me`;
    const token2 = await inviterDuo(d2.tok, email2, d2.duoId);
    await inscrire(email2, token2);
    const v2 = await activer(email2);
    const { DELETE } = await import('@/app/api/duo/invitation/route');
    expect((await DELETE(req('/api/duo/invitation', { method: 'DELETE', cookie: ck(d2.tok) }))).status).toBe(200);
    expect((await rejoindre(v2.access, { token: token2 })).status).toBe(404);
    // Concurrentes : deux acceptations simultanées → une seule adhésion.
    const d3 = await duoActif('CONCUR');
    const email3 = `${uid('conc')}@proton.me`;
    const token3 = await inviterDuo(d3.tok, email3, d3.duoId);
    await inscrire(email3, token3);
    const v3 = await activer(email3);
    const [a, b] = await Promise.all([rejoindre(v3.access, { token: token3 }), rejoindre(v3.access, { token: token3 })]);
    expect([a.status, b.status].sort()).toEqual([200, 200]);
    const [u3] = await sql<{ id: number }[]>`SELECT id FROM users WHERE email = ${email3}`;
    expect(await sql`SELECT 1 FROM account_memberships WHERE account_id = ${d3.acc.id} AND user_id = ${u3.id}`).toHaveLength(1);
    // Place prise : une nouvelle invitation est refusée.
    const { POST } = await import('@/app/api/duo/invitation/route');
    expect((await POST(req('/api/duo/invitation', { body: { email: `${uid('trop')}@proton.me` }, cookie: ck(d3.tok) }))).status).toBe(409);
  });

  it('L72D-13 — retrait et départ : révocation immédiate, anciens jetons refusés, données conservées, rien créé', async () => {
    const d = await duoActif('SORTIE');
    const inv = await nouvelInvite(d);
    const ancien = inv.j.access;
    expect((await listeBiens(ancien)).status).toBe(200);
    const { DELETE } = await import('@/app/api/duo/member/route');
    expect((await DELETE(req('/api/duo/member', { method: 'DELETE', cookie: ck(d.tok) }))).status).toBe(200);
    expect((await listeBiens(ancien)).status).toBe(401);
    expect(await sql`SELECT status, ended_reason FROM account_memberships WHERE account_id = ${d.acc.id} AND user_id = ${inv.user.id}`)
      .toEqual([{ status: 'removed', ended_reason: 'removed' }]);
    expect(await sql`SELECT 1 FROM assets WHERE account_id = ${d.acc.id} AND deleted_at IS NULL`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM accounts WHERE owner_user_id = ${inv.user.id}`).toHaveLength(0);
    // Identité préservée : connexion sans espace (écran dédié).
    const l = await connecter(inv.email);
    expect(l.status).toBe(200);
    expect((await moi(l.access)).body.accountId).toBeNull();
    // Nouvelle invitation : la même ligne d'adhésion est réactivée.
    const token = await inviterDuo(d.tok, inv.email, d.duoId);
    const j = await rejoindre(l.access, { token });
    expect(j.status).toBe(200);
    expect(await sql`SELECT status FROM account_memberships WHERE account_id = ${d.acc.id} AND user_id = ${inv.user.id}`).toEqual([{ status: 'active' }]);
    // Départ volontaire : session rouverte sans espace, ancien jeton refusé.
    const { POST } = await import('@/app/api/duo/leave/route');
    const p = await POST(req('/api/duo/leave', { body: {}, cookie: ck(j.access) }));
    expect(p.status).toBe(200);
    expect((await claims((p as WithCookies).cookies.get('access_token')?.value))?.currentAccountId).toBeUndefined();
    expect((await listeBiens(j.access)).status).toBe(401);
    expect(await sql`SELECT status, ended_reason FROM account_memberships WHERE account_id = ${d.acc.id} AND user_id = ${inv.user.id}`)
      .toEqual([{ status: 'left', ended_reason: 'left' }]);
    expect((await sql<{ status: string }[]>`SELECT status FROM duo_memberships WHERE duo_id = ${d.duoId} AND user_id = ${inv.user.id}`)[0].status).toBe('LEFT');
  });

  it('L72D-14 — résiliation et impayé : restrictions et récupération conformes', async () => {
    const { applyPlanChange } = await import('@/lib/plan-enforcement');
    // Impayé : le membre garde lecture (et export), l'écriture est refusée, il ne peut être retiré.
    const d = await duoActif('IMPAYE');
    const inv = await nouvelInvite(d);
    await applyPlanChange({ accountId: d.acc.id, ownerUserId: d.owner.id, oldPlanType: 'PREMIUM_DUO', newPlanType: 'PREMIUM_DUO',
      newSubStatus: 'PAST_DUE', newPremiumUntil: null, newMaxMembers: 2, source: 'e2e:l72d', sendEmails: false });
    await sql`UPDATE account_subscriptions SET status = 'past_due' WHERE account_id = ${d.acc.id}`;
    expect((await listeBiens(inv.j.access)).status).toBe(200);
    const { POST } = await import('@/app/api/assets/route');
    expect((await POST(req('/api/assets', { body: { name: 'IMPAYE-x', category: 'VEHICULE' }, cookie: ck(inv.j.access) }))).status).toBe(403);
    const { DELETE } = await import('@/app/api/duo/member/route');
    expect((await DELETE(req('/api/duo/member', { method: 'DELETE', cookie: ck(d.tok) }))).status).toBe(409);
    expect((await adhesion(d.acc.id, inv.user.id))?.status).toBe('active');
    // Résiliation effective (retour en Standard) : adhésion retirée, données conservées.
    const d2 = await duoActif('RESIL');
    const inv2 = await nouvelInvite(d2);
    await applyPlanChange({ accountId: d2.acc.id, ownerUserId: d2.owner.id, oldPlanType: 'PREMIUM_DUO', newPlanType: 'STANDARD',
      newSubStatus: 'CANCELED', newPremiumUntil: null, newMaxMembers: 1, source: 'e2e:l72d', sendEmails: false });
    expect(await sql`SELECT status, ended_reason FROM account_memberships WHERE account_id = ${d2.acc.id} AND user_id = ${inv2.user.id}`)
      .toEqual([{ status: 'removed', ended_reason: 'offer_ended' }]);
    expect((await listeBiens(inv2.j.access)).status).toBe(401);
    expect(await sql`SELECT 1 FROM assets WHERE account_id = ${d2.acc.id} AND deleted_at IS NULL`).toHaveLength(1);
    // Les anciennes routes de « récupération » / validation croisée répondent 410.
    const { GET: recup } = await import('@/app/api/duos/[id]/recovery/assets/route');
    expect((await recup(req(`/api/duos/${d.duoId}/recovery/assets`, { cookie: ck(inv.j.access) }))).status).toBe(410);
    const { POST: transfert } = await import('@/app/api/assets/[id]/move-request/route');
    expect((await transfert(req(`/api/assets/${d.bien.id}/move-request`, { body: {}, cookie: ck(inv.j.access) }))).status).toBe(410);
  });

  it('L72D-16 — conversations et préférences personnelles isolées', async () => {
    const d = await duoActif('PRIVE');
    const inv = await nouvelInvite(d);
    const { POST, GET } = await import('@/app/api/verebona/conversations/route');
    const cree = await POST(req('/api/verebona/conversations', { body: {}, cookie: ck(inv.j.access) }));
    expect(cree.status).toBe(201);
    const { conversationId } = await cree.json() as { conversationId: string | number };
    const duMembre = await (await GET(req('/api/verebona/conversations', { cookie: ck(inv.j.access) }))).text();
    const duTitulaire = await (await GET(req('/api/verebona/conversations', { cookie: ck(d.tok) }))).text();
    expect(duMembre).toContain(String(conversationId));
    expect(duTitulaire).not.toContain(String(conversationId));
    const { PATCH } = await import('@/app/api/notification-preferences/route');
    const avant = await sql`SELECT * FROM notification_preferences WHERE user_id = ${d.owner.id}`;
    const r = await PATCH(req('/api/notification-preferences', { method: 'PATCH', body: { changes: [{ category: 'documents', channel: 'push', enabled: false }] }, cookie: ck(inv.j.access) }));
    expect(r.status).toBeLessThan(500);
    expect(await sql`SELECT * FROM notification_preferences WHERE user_id = ${d.owner.id}`).toEqual(avant);
  });

  it('L72D-17 — architecture générique : plusieurs membres sans refonte (vérification d’adresse exigée)', async () => {
    const titulaire = await make.account({ plan: 'premium_duo', name: 'Compte multi' });
    await sql`UPDATE accounts SET plan_type = 'PREMIUM_DUO', max_members = 3 WHERE id = ${titulaire.id}`;
    await make.asset(titulaire, { name: 'MULTI-grange' });
    const tokT = await jeton(titulaire.owner, titulaire.id);
    const { POST } = await import('@/app/api/accounts/[accountId]/members/invite/route');
    const membres: string[] = [];
    for (const n of [1, 2]) {
      const email = `${uid(`multi${n}`)}@proton.me`;
      const r = await POST(req(`/api/accounts/${titulaire.id}/members/invite`, { body: { email }, cookie: ck(tokT) }), params({ accountId: titulaire.id }));
      expect(r.status).toBe(200);
      const { inviteToken } = await r.json() as { inviteToken: string };
      expect((await inscrire(email, inviteToken)).status).toBe(201);
      // Avant vérification : identité inactive, invitation toujours en attente (Q10).
      expect(await sql`SELECT m.status, u.is_active FROM account_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ${email}`)
        .toEqual([{ status: 'pending', is_active: false }]);
      const v = await activer(email);
      expect(v.location).toContain('joined=1');
      expect((await claims(v.access))?.currentAccountId).toBe(titulaire.id);
      expect((await listeBiens(v.access)).text).toContain('MULTI-grange');
      membres.push(email);
    }
    expect(await sql`SELECT 1 FROM account_memberships WHERE account_id = ${titulaire.id} AND status = 'active'`).toHaveLength(3);
    const r = await POST(req(`/api/accounts/${titulaire.id}/members/invite`, { body: { email: `${uid('multi3')}@proton.me` }, cookie: ck(tokT) }), params({ accountId: titulaire.id }));
    expect(r.status).toBe(400);
  });

  it('L72D-18 — non-régression : inscription classique (essai), Premium individuel, Standard', async () => {
    const e = await inscritClassique('classique-72d');
    const me = await moi(e.access);
    expect(me.body).toMatchObject({ accountId: e.perso, accountRole: 'owner', duoRole: null, subscription: { trialStatus: 'active' } });
    expect(await sql`SELECT 1 FROM trial_grants WHERE email_normalized = ${e.email}`).toHaveLength(1);
    const premium = await make.account({ plan: 'premium' });
    await sql`UPDATE accounts SET plan_type = 'PREMIUM' WHERE id = ${premium.id}`;
    expect((await moi(await jeton(premium.owner, premium.id))).body).toMatchObject({ effectivePlan: 'PREMIUM', accountRole: 'owner', duoRole: null });
    const standard = await make.account({ plan: 'standard' });
    expect((await moi(await jeton(standard.owner, standard.id))).body).toMatchObject({ effectivePlan: 'STANDARD', accountRole: 'owner' });
  });

  it('L72D-19 — notifications : facturation et essai au seul titulaire ; métier à tous ; compte archivé muet', async () => {
    const d = await duoActif('NOTIF');
    const inv = await nouvelInvite(d);
    const { resolveRecipients } = await import('@/lib/notifications/recipient-resolver');
    expect(await resolveRecipients({ accountId: d.acc.id, type: 'TRIAL_ENDED' })).toEqual([d.owner.id]);
    expect(await resolveRecipients({ accountId: d.acc.id, type: 'PAYMENT_FAILED' })).toEqual([d.owner.id]);
    expect((await resolveRecipients({ accountId: d.acc.id, type: 'DEADLINE_REMINDER' })).sort()).toEqual([d.owner.id, inv.user.id].sort());
    await sql`UPDATE accounts SET archived_at = now() WHERE id = ${d.acc.id}`;
    expect(await resolveRecipients({ accountId: d.acc.id, type: 'TRIAL_ENDING' })).toEqual([]);
    await sql`UPDATE accounts SET archived_at = NULL WHERE id = ${d.acc.id}`;
    // Lien profond : la cloche connaît l'espace émetteur.
    const { emit } = await import('@/lib/notifications');
    await emit({ type: 'DEADLINE_REMINDER' as never, accountId: d.acc.id, recipientUserIds: [inv.user.id], payload: {} as never, dedupeKey: `l72d-${uid('n')}` }).catch(() => undefined);
    const { withSpaceParam } = await import('@/lib/shell/space-link');
    expect(withSpaceParam('/assets/3?tab=docs', d.acc.id)).toBe(`/assets/3?tab=docs&space=${d.acc.id}`);
    expect(withSpaceParam('https://ext.example/x', d.acc.id)).toBe('https://ext.example/x');
  });

  it('L72D-20 — identité sans espace (Q8) : « Rejoindre » ou « Créer mon espace » (essai seulement si jamais utilisé)', async () => {
    const d = await duoActif('SANSESPACE');
    const email = `${uid('sans')}@proton.me`;
    const token = await inviterDuo(d.tok, email, d.duoId);
    await inscrire(email, token);
    const v = await activer(email);
    expect(v.location).toContain('duo=1');
    expect(v.location).toContain('space=none');
    expect((await moi(v.access)).body.accountId).toBeNull();
    const { GET } = await import('@/app/api/accounts/route');
    expect((await (await GET(req('/api/accounts', { cookie: ck(v.access) }))).json()).options).toEqual({ pendingDuoInvitation: true, trialAvailable: true });
    // L'invitation est annulée : il crée son espace (essai accordé une fois).
    const { DELETE } = await import('@/app/api/duo/invitation/route');
    await DELETE(req('/api/duo/invitation', { method: 'DELETE', cookie: ck(d.tok) }));
    const { POST } = await import('@/app/api/accounts/personal/route');
    const c1 = await POST(req('/api/accounts/personal', { method: 'POST', cookie: ck(v.access) }));
    expect(c1.status).toBe(200);
    const body = await c1.json() as { accountId: number; trialGranted: boolean };
    expect(body.trialGranted).toBe(true);
    const nouveau = (c1 as WithCookies).cookies.get('access_token')?.value;
    expect((await claims(nouveau))?.currentAccountId).toBe(body.accountId);
    expect((await POST(req('/api/accounts/personal', { method: 'POST', cookie: ck(nouveau) }))).status).toBe(409);
  });

  it('L72D-15 — rattrapage BO : simulation, application, rejeu sans effet, restauration ; migrations rejouables', async () => {
    // Situation HISTORIQUE (avant 72D) : invité inscrit par l'ancien parcours
    // (compte personnel + essai), rattaché au Duo par la seule ligne
    // duo_memberships — reproduite telle que l'ancien `join` l'écrivait.
    const d = await duoActif('MIGR');
    // Compte personnel créé par l'ancienne inscription sur invitation, jamais utilisé.
    const e = await inscritClassique('ancien-invite', { bien: false });
    // Un second invité historique dont le compte personnel A des données : jamais touché (D2).
    const e2 = await inscritClassique('ancien-invite-donnees');
    const d2 = await duoActif('MIGR2');
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot, invited_at, joined_at) VALUES (${d2.duoId}, ${e2.user.id}, 'ACTIVE', 1, now(), now() + interval '1 minute')`;
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot, invited_at, joined_at) VALUES (${d.duoId}, ${e.user.id}, 'ACTIVE', 1, now(), now() + interval '1 minute')`;
    await sql`UPDATE users SET plan_type = 'PREMIUM_DUO' WHERE id = ${e.user.id}`;
    // Compte historique sans adhésion titulaire.
    const vieux = await make.account({ name: 'Compte historique' });
    await sql`DELETE FROM account_memberships WHERE account_id = ${vieux.id}`;
    const { runDuoSharedAccountBackfill, restoreDuoSharedAccountRun } = await import('@/services/account/duo-shared-account-backfill');
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    const { validateBackfillRequest } = await import('@/services/admin/ops/backfill/definitions');
    expect(validateBackfillRequest({ script: 'duo-shared-account', action: 'apply', reason: 'Recette 72D' })).toMatchObject({ ok: true });

    const sim = await runDuoSharedAccountBackfill(sql as never, { apply: false });
    expect(sim.before.B).toBeGreaterThanOrEqual(1);
    expect(sim.before.A).toBeGreaterThanOrEqual(1);
    const ligne = sim.duos.find((x) => x.memberUserId === e.user.id)!;
    expect(ligne.personalAccounts).toEqual([expect.objectContaining({ accountId: e.perso, category: 'D1', archived: false, trial: 'trialing' })]);
    expect(sim.duos.find((x) => x.memberUserId === e2.user.id)!.personalAccounts).toEqual([expect.objectContaining({ accountId: e2.perso, category: 'D2' })]);
    expect(await adhesion(d.acc.id, e.user.id)).toBeUndefined(); // simulation : rien écrit
    expect(summarizeBackfill('duo-shared-account', 'simulate', null, { result: sim }).headline).toMatch(/^Simulation : \d+ membre\(s\) Duo à rattacher/);

    const app = await runDuoSharedAccountBackfill(sql as never, { apply: true });
    expect(app.runId).toBeTruthy();
    expect(app.after?.B).toBe(0);
    expect(await adhesion(d.acc.id, e.user.id)).toEqual({ role: 'member', status: 'active' });
    expect(await adhesion(vieux.id, vieux.owner.id)).toEqual({ role: 'owner', status: 'active' });
    expect((await sql<{ archived_reason: string }[]>`SELECT archived_reason FROM accounts WHERE id = ${e.perso}`)[0].archived_reason).toBe('duo_placeholder');
    // Compte avec données : jamais archivé ; le membre est rattaché, son espace reste disponible.
    expect((await sql<{ archived_at: Date | null }[]>`SELECT archived_at FROM accounts WHERE id = ${e2.perso}`)[0].archived_at).toBeNull();
    expect(await adhesion(d2.acc.id, e2.user.id)).toEqual({ role: 'member', status: 'active' });
    // Essai consommé : aucune remise à zéro.
    expect(await sql`SELECT 1 FROM trial_grants WHERE email_normalized = ${e.email}`).toHaveLength(1);
    // Après rattrapage, l'invité ouvre le Duo et n'a plus de compte artificiel proposé.
    const l = await connecter(e.email);
    expect((await claims(l.access))?.currentAccountId).toBe(d.acc.id);
    expect((await moi(l.access)).body.accountsCount).toBe(1);
    expect(summarizeBackfill('duo-shared-account', 'apply', null, { result: app })).toMatchObject({ restorable: true, scriptRunId: app.runId });

    // Rejeu : aucune action, aucun doublon.
    const rejeu = await runDuoSharedAccountBackfill(sql as never, { apply: true });
    expect(Object.values(rejeu.actions).every((n) => n === 0)).toBe(true);
    expect(await sql`SELECT 1 FROM account_memberships WHERE account_id = ${d.acc.id} AND user_id = ${e.user.id}`).toHaveLength(1);

    // Restauration de la première application.
    const rest = await restoreDuoSharedAccountRun(sql as never, app.runId!);
    expect(rest.conflicts).toEqual([]);
    expect((await adhesion(d.acc.id, e.user.id))?.status).toBe('removed');
    expect((await sql<{ archived_at: Date | null }[]>`SELECT archived_at FROM accounts WHERE id = ${e.perso}`)[0].archived_at).toBeNull();
    expect(await sql`SELECT 1 FROM duo_shared_account_journal WHERE run_id = ${app.runId!} AND restored_at IS NULL`).toHaveLength(0);

    // Migrations 0519-0522 rejouables sans effet.
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { runMigrationSql } = await import('@/db/migration-index');
    for (const f of ['0519_l72d_account_memberships.sql', '0520_l72d_duo_account_link.sql', '0521_l72d_duo_migration_journal.sql', '0522_l72d_cancel_cross_validation.sql']) {
      const texte = await readFile(join(process.cwd(), 'src/db/migrations', f), 'utf-8');
      for (const passe of [1, 2]) {
        const cnx = await sql.reserve();
        try {
          await expect(runMigrationSql({ unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> }, texte), `${f} passe ${passe}`).resolves.toMatchObject({ status: 'applied' });
        } finally { cnx.release(); }
      }
    }
    expect((await sql<{ account_id: number }[]>`SELECT account_id FROM duo_accounts WHERE id = ${d.duoId}`)[0].account_id).toBe(d.acc.id);
  });

  it('L72D-21 — BO « Réattribuer un essai » (Q4) : manuel, motif obligatoire, trace conservée, refusé si essai en cours', async () => {
    const admin = await make.user({ email: `${uid('adm72d')}@verebona.test`, role: 'ADMIN' });
    await sql`UPDATE users SET role = 'ADMIN', is_active = true, status = 'ACTIVE' WHERE id = ${admin.id}`;
    const { generateAccessToken } = await import('@/lib/jwt');
    const tokAdmin = await generateAccessToken({ id: admin.id, email: admin.email, role: 'ADMIN' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never, hasActiveAccount: true });
    const e = await inscritClassique('essai-rendu', { bien: false });
    const { POST } = await import('@/app/api/admin/users/[id]/reassign-trial/route');
    const appel = (reason: string) => POST(req(`/api/admin/users/${e.user.id}/reassign-trial`, { body: { reason }, cookie: ck(tokAdmin) }), params({ id: e.user.id }));
    expect((await appel('x')).status).toBe(400);
    expect((await appel('Ancien invité Duo, essai artificiel')).status).toBe(409); // essai EN COURS : rien à rendre
    const { runTrialExpiry } = await import('@/services/trial-expiry.job');
    await runTrialExpiry(new Date(Date.now() + 8 * 24 * 3600 * 1000));
    const r = await appel('Ancien invité Duo, essai artificiel');
    expect(r.status, await r.clone().text()).toBe(200);
    const { hasUsedTrial } = await import('@/services/trial.service');
    expect(await hasUsedTrial(e.email)).toBe(false);
    expect(await sql`SELECT 1 FROM trial_grants WHERE email_normalized LIKE ${`${e.email}#reattribue:%`}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM admin_audit_log WHERE action_type = 'USER_TRIAL_REASSIGNED' AND target_id = ${e.user.id} AND result = 'SUCCESS'`).toHaveLength(1);
  });
});
