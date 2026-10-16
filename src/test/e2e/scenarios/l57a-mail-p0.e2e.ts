/**
 * Lot 57A — ticket P0 « Corriger les échecs d'e-mails bloquant l'inscription,
 * la vérification des comptes et les invitations Duo ». Base PostgreSQL 16
 * réelle (migration 0405), vraies routes, transport Resend SIMULÉ
 * (réponses programmables), horloge maîtrisée pour les reprises.
 *
 * MAIL-P0-E2E-01 inscription Proton neuve : demande durable AVANT la
 *                réponse, e-mail accepté, identifiant Resend, lien activé,
 *                connexion ; aucune session avant vérification ; métadonnées
 *                sans jeton.
 * MAIL-P0-E2E-02 échec initial (Resend) puis reprise réussie par la tâche
 *                planifiée (horloge : rien avant l'échéance) ; lien valable.
 * MAIL-P0-E2E-03 redémarrage du processus : demande jamais tentée, tentative
 *                interrompue (verrou expiré) → reprises, sans doublon.
 * MAIL-P0-E2E-04 clé API absente, domaine expéditeur non vérifié : cause
 *                lisible, reprise bornée (6 tentatives), compte non activé.
 * MAIL-P0-E2E-05 renvoi : réponses neutres identiques, une seule demande
 *                ouverte (pas de doublon), ancien lien toujours valable.
 * MAIL-P0-E2E-06 réinscription d'une adresse non vérifiée : même mot de
 *                passe → compte et ancien lien conservés ; autre mot de passe
 *                → ancien lien invalidé (identifiants changés).
 * MAIL-P0-E2E-07 expiration (24 h) et usage unique des liens.
 * MAIL-P0-E2E-08 webhooks : signature invalide / secret absent refusés ;
 *                rejeu sans effet ; ordre indifférent ; événement reçu avant
 *                la journalisation appliqué ensuite.
 * MAIL-P0-E2E-09 invitation Duo : échec → aucune expédition annoncée ni
 *                date ; invitation exploitable ; reprise → date posée ;
 *                destinataire = invité, émetteur = titulaire ; rejet Resend
 *                visible du titulaire.
 * MAIL-P0-E2E-10 renvoi Duo depuis le BO : échec rendu (502), succès rendu.
 * MAIL-P0-E2E-11 BO : recherche par type et destinataire, statut, erreur,
 *                identifiant Resend, demandes en attente ; aucun jeton.
 * MAIL-P0-E2E-12 autres e-mails inchangés : réinitialisation du mot de
 *                passe, confirmation légale (envoi direct, `sent`).
 */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';

const APP = 'https://app.e2e.verebona.test';
const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  process.env.APP_URL = 'https://app.e2e.verebona.test';
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from('l57a-secret-e2e').toString('base64')}`;
  return {
    calls: [] as Array<{ to: string; subject: string; html: string; key?: string }>,
    /** Réponses programmées : une erreur Resend, ou `null` = acceptation. */
    plan: [] as Array<{ name: string; message: string } | null>,
    n: 0,
  };
});
afterAll(() => { delete process.env.RESEND_API_KEY; delete process.env.RESEND_WEBHOOK_SECRET; });

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string; subject: string; html: string }, o?: { idempotencyKey?: string }) => {
        const err = etat.plan.length ? etat.plan.shift() : null;
        if (err) return { data: null, error: err };
        etat.calls.push({ ...p, key: o?.idempotencyKey });
        etat.n += 1;
        return { data: { id: `em_57a_${etat.n}` }, error: null };
      },
    };
  },
}));

const PASSWORD = 'NouveauMdp1!x';
const MIN = 60_000;

function req(path: string, init: { body?: unknown; cookie?: string; method?: string; headers?: Record<string, string>; raw?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: APP, host: 'app.e2e.verebona.test', ...init.headers };
  if (init.cookie) headers.cookie = init.cookie;
  headers['x-forwarded-for'] ??= `92.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}.7`;
  return new NextRequest(`${APP}${path}`, {
    method: init.method ?? 'POST', headers,
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
}
type WithCookies = Response & { cookies: { get(n: string): { value: string } | undefined } };
const lienDe = (html: string) => {
  const m = /href="([^"]*\/api\/auth\/verify-email\?token=[^"]+)"/.exec(html);
  if (!m) throw new Error('aucun lien de vérification dans l’e-mail');
  return m[1].replace(/&amp;/g, '&');
};
const mailsA = (to: string) => etat.calls.filter((c) => c.to === to);

scenario('L57A-MAIL', 'P0 e-mails : vérification et invitations Duo fiables', ({ sql, make }) => {
  beforeEach(async () => {
    etat.plan.length = 0;
    process.env.RESEND_API_KEY = 're_e2e_simule';
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@preprod.verebona.fr', 'support@verebona.fr')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true, sender_name = 'Verebona',
                sender_email = 'bonjour@preprod.verebona.fr', reply_to_email = 'support@verebona.fr'`;
    // Lot 64A : l'ordre des fichiers n'est pas garanti (même base) — un autre
    // scénario a pu changer l'expéditeur (L61B corrige l'expéditeur depuis le BO).
    // Lot 64A : les sorties de Duo des fichiers précédents (même base) laissent
    // des demandes DUO_MEMBERSHIP_ENDED ; la reprise les prendrait et
    // consommerait les réponses Resend programmées ici (lot 65A : départs
    // volontaires, DUO_MEMBERSHIP_LEFT, de même).
    await sql`UPDATE transactional_email_jobs SET status = 'cancelled'
               WHERE kind IN ('DUO_MEMBERSHIP_ENDED', 'DUO_MEMBERSHIP_LEFT') AND status IN ('pending', 'sending')`;
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
  async function inscription(email: string, over: Record<string, unknown> = {}) {
    const { POST } = await import('@/app/api/users/route');
    const res = await POST(req('/api/users', {
      body: { email, password: PASSWORD, firstName: 'Alice', lastName: 'Proton', acceptedTerms: true, termsVersion: await cgvu(), ...over },
    }));
    return { status: res.status, body: await res.json() };
  }
  const settle = async () => (await import('@/lib/auth/anti-enumeration')).settleDetachedAuthTasks();
  const job = async (email: string) => (await sql<{ id: number; status: string; attempts: number; next_attempt_at: Date; last_error: string | null; user_id: number | null }[]>`
    SELECT id, status, attempts, next_attempt_at, last_error, user_id FROM transactional_email_jobs
     WHERE lower(recipient_email) = lower(${email}) ORDER BY id DESC LIMIT 1`)[0];
  const actif = async (email: string) => (await sql<{ is_active: boolean }[]>`SELECT is_active FROM users WHERE email = ${email}`)[0]?.is_active;
  async function verifier(url: string) {
    const { GET } = await import('@/app/api/auth/verify-email/route');
    const res = await GET(new NextRequest(url));
    return { location: res.headers.get('location') ?? '', access: (res as WithCookies).cookies.get('access_token')?.value };
  }
  async function connexion(email: string) {
    const { POST } = await import('@/app/api/auth/login/route');
    const res = await POST(req('/api/auth/login', { body: { email, password: PASSWORD } }));
    return { status: res.status, access: (res as WithCookies).cookies.get('access_token')?.value };
  }
  const retry = async (at: Date) => (await import('@/services/email/transactional-email-jobs.service'))
    .runTransactionalEmailRetry({ now: () => at, deadline: Date.now() + 30_000 });

  it('MAIL-P0-E2E-01 — inscription Proton neuve : demande durable, e-mail accepté, activation, connexion ; jamais de session avant', async () => {
    const email = `${uid('alice')}@proton.me`;
    const r = await inscription(email);
    expect(r.status).toBe(201);
    expect(r.body.message).toMatch(/^Demande enregistrée/);
    // Demande ENREGISTRÉE avant la réponse (survit à un arrêt du processus).
    const j0 = await job(email);
    expect(j0).toBeTruthy();
    // Aucune session sans vérification.
    const avant = await connexion(email);
    expect(avant.status).toBeGreaterThanOrEqual(400);
    expect(avant.access).toBeUndefined();

    await settle();
    expect((await job(email)).status).toBe('accepted');
    const [log] = await sql<{ status: string; provider_message_id: string; delivery_status: string; metadata: string; email_job_id: number; recipient_user_id: number }[]>`
      SELECT status, provider_message_id, delivery_status, metadata, email_job_id, recipient_user_id FROM email_logs
       WHERE template_code = 'EMAIL_VERIFICATION' AND recipient_email = ${email}`;
    expect(log.status).toBe('sent'); // sens inchangé : accepté par Resend
    expect(log.delivery_status).toBe('accepted');
    expect(log.provider_message_id).toMatch(/^em_57a_/);
    expect(log.email_job_id).toBe(j0.id);
    expect(log.metadata).toContain('token=[masqué]');
    expect(mailsA(email)).toHaveLength(1);
    expect(mailsA(email)[0].key).toBe(`vb-email-job-${j0.id}-1`);

    const v = await verifier(lienDe(mailsA(email)[0].html));
    expect(v.location).toContain('status=success');
    expect(v.access).toBeTruthy();
    expect(await actif(email)).toBe(true);
    const apres = await connexion(email);
    expect(apres.status).toBe(200);
  });

  it('MAIL-P0-E2E-02 — échec initial puis reprise réussie (horloge maîtrisée)', async () => {
    const email = `${uid('bob')}@proton.me`;
    etat.plan.push({ name: 'rate_limit_exceeded', message: 'Too many requests' });
    expect((await inscription(email)).status).toBe(201);
    await settle();
    const j = await job(email);
    expect(j.status).toBe('pending');
    expect(j.attempts).toBe(1);
    expect(j.last_error).toMatch(/Too many requests/);
    const [log] = await sql<{ status: string; error_message: string }[]>`
      SELECT status, error_message FROM email_logs WHERE recipient_email = ${email} ORDER BY id DESC LIMIT 1`;
    expect(log).toEqual({ status: 'failed', error_message: '[rate_limit_exceeded] Too many requests' });
    expect(mailsA(email)).toHaveLength(0);
    expect(await actif(email)).toBe(false); // jamais activé sans vérification

    const t0 = new Date(j.next_attempt_at).getTime();
    expect(t0 - Date.now()).toBeGreaterThan(50_000); // reprise dans ~1 min
    await retry(new Date(t0 - 30_000)); // pas encore dû
    expect((await job(email)).attempts).toBe(1);
    // L'échéance passe (horloge de la base avancée d'autant : le lien est
    // signé à l'heure de la tentative, il doit rester vérifiable).
    await sql`UPDATE transactional_email_jobs SET next_attempt_at = next_attempt_at - interval '61 seconds' WHERE id = ${j.id}`;
    await retry(new Date());
    expect((await job(email)).status).toBe('accepted');
    expect(mailsA(email)).toHaveLength(1);
    expect((await verifier(lienDe(mailsA(email)[0].html))).location).toContain('status=success');
  });

  it('MAIL-P0-E2E-03 — redémarrage : demande jamais tentée et tentative interrompue reprises, sans doublon', async () => {
    const { enqueueVerificationEmail } = await import('@/services/email/transactional-email-jobs.service');
    const u = await make.user({ email: `${uid('crash')}@proton.me` });
    await sql`UPDATE users SET is_active = false WHERE id = ${u.id}`;
    // Processus arrêté juste après l'enregistrement : rien n'a été tenté.
    const { jobId } = await enqueueVerificationEmail({ userId: u.id, email: u.email });
    expect((await enqueueVerificationEmail({ userId: u.id, email: u.email })).jobId).toBe(jobId); // pas de doublon
    await retry(new Date(Date.now() + 1_000));
    expect((await job(u.email)).status).toBe('accepted');
    expect(mailsA(u.email)).toHaveLength(1);

    // Tentative interrompue (verrou posé, processus arrêté pendant l'envoi).
    const u2 = await make.user({ email: `${uid('crash2')}@proton.me` });
    await sql`UPDATE users SET is_active = false WHERE id = ${u2.id}`;
    const j2 = await enqueueVerificationEmail({ userId: u2.id, email: u2.email });
    const now = Date.now();
    await sql`UPDATE transactional_email_jobs SET status = 'sending', attempts = 1, locked_until = ${new Date(now + 2 * MIN).toISOString()} WHERE id = ${j2.jobId}`;
    await retry(new Date(now + MIN)); // verrou encore valable : rien
    expect(mailsA(u2.email)).toHaveLength(0);
    await retry(new Date(now + 3 * MIN));
    expect((await job(u2.email)).status).toBe('accepted');
    expect(mailsA(u2.email)).toHaveLength(1);
  });

  it('MAIL-P0-E2E-04 — clé API absente, domaine non vérifié : cause lisible, reprise bornée, compte non activé', async () => {
    const email = `${uid('cle')}@proton.me`;
    delete process.env.RESEND_API_KEY;
    expect((await inscription(email)).status).toBe(201);
    await settle();
    expect((await job(email)).last_error).toBe('Email provider not configured');
    process.env.RESEND_API_KEY = 're_e2e_simule';

    const domain = { name: 'validation_error', message: 'The preprod.verebona.fr domain is not verified.' };
    const { processEmailJob } = await import('@/services/email/transactional-email-jobs.service');
    const id = (await job(email)).id;
    let t = new Date((await job(email)).next_attempt_at).getTime();
    const ecarts: number[] = [];
    for (let i = 0; i < 5; i++) {
      etat.plan.push(domain);
      const r = await processEmailJob(id, new Date(t + 1_000));
      if (r.nextAttemptAt) ecarts.push(Math.round((new Date(r.nextAttemptAt).getTime() - (t + 1_000)) / MIN));
      t = new Date((await job(email)).next_attempt_at).getTime();
    }
    expect(ecarts).toEqual([5, 15, 60, 180]); // espacement croissant
    const fin = await job(email);
    expect(fin.status).toBe('failed');
    expect(fin.attempts).toBe(6);
    expect((await processEmailJob(id, new Date(t + 10 * 60 * MIN))).status).toBe('busy'); // plus aucune tentative
    expect((await job(email)).attempts).toBe(6);
    const [log] = await sql<{ error_message: string }[]>`
      SELECT error_message FROM email_logs WHERE recipient_email = ${email} ORDER BY id DESC LIMIT 1`;
    expect(log.error_message).toBe('[validation_error] The preprod.verebona.fr domain is not verified.');
    expect(await actif(email)).toBe(false);
    // Le renvoi ouvre une nouvelle demande (parcours récupérable).
    const { POST } = await import('@/app/api/auth/resend-verification/route');
    expect((await POST(req('/api/auth/resend-verification', { body: { email } }))).status).toBe(200);
    await settle();
    expect((await job(email)).status).toBe('accepted');
  });

  it('MAIL-P0-E2E-05 — renvoi : réponses neutres identiques, une seule demande ouverte, ancien lien valable', async () => {
    const email = `${uid('renvoi')}@proton.me`;
    await inscription(email);
    await settle();
    const premier = lienDe(mailsA(email)[0].html);
    const { POST } = await import('@/app/api/auth/resend-verification/route');
    const reps = [];
    for (const e of [email, `${uid('inconnu')}@proton.me`]) {
      const res = await POST(req('/api/auth/resend-verification', { body: { email: e } }));
      reps.push({ status: res.status, body: await res.json() });
    }
    expect(reps[1]).toEqual(reps[0]);
    expect(reps[0].body.message).toMatch(/^Demande enregistrée/);
    await settle();
    expect(mailsA(email)).toHaveLength(2);
    // Deux demandes simultanées : une seule demande ouverte.
    etat.plan.push({ name: 'application_error', message: 'Resend indisponible' });
    await Promise.all([1, 2].map(() => POST(req('/api/auth/resend-verification', { body: { email } }))));
    await settle();
    const ouvertes = await sql`SELECT id FROM transactional_email_jobs WHERE recipient_email = ${email} AND status IN ('pending', 'sending')`;
    expect(ouvertes.length).toBeLessThanOrEqual(1);
    // L'ancien lien n'a pas été invalidé par les renvois.
    expect((await verifier(premier)).location).toContain('status=success');
  });

  it('MAIL-P0-E2E-06 — réinscription d’une adresse non vérifiée : parcours conservé (même mot de passe)', async () => {
    const email = `${uid('reins')}@proton.me`;
    await inscription(email);
    await settle();
    const [u1] = await sql<{ id: number }[]>`SELECT id FROM users WHERE email = ${email}`;
    const ancien = lienDe(mailsA(email)[0].html);
    const again = await inscription(email);
    expect(again.status).toBe(201);
    await settle();
    const [u2] = await sql<{ id: number }[]>`SELECT id FROM users WHERE email = ${email}`;
    expect(u2.id).toBe(u1.id);
    expect(mailsA(email)).toHaveLength(2);
    expect((await verifier(ancien)).location).toContain('status=success');

    // Autre mot de passe : identifiants changés → l'ancien lien n'active plus rien.
    const email2 = `${uid('reins2')}@proton.me`;
    await inscription(email2);
    await settle();
    const vieux = lienDe(mailsA(email2)[0].html);
    await inscription(email2, { password: 'AutreMdp2!y' });
    await settle();
    expect((await verifier(vieux)).location).toContain('error=invalid_token');
    expect((await verifier(lienDe(mailsA(email2)[1].html))).location).toContain('status=success');
  });

  it('MAIL-P0-E2E-07 — expiration (24 h) et usage unique des liens', async () => {
    const email = `${uid('exp')}@proton.me`;
    await inscription(email);
    await settle();
    const lien = lienDe(mailsA(email)[0].html);
    const [u] = await sql<{ id: number }[]>`SELECT id FROM users WHERE email = ${email}`;
    const { buildEmailVerificationUrl } = await import('@/services/auth/email-verification.service');
    const vieux = buildEmailVerificationUrl(APP, { id: u.id, email }, null, Date.now() - 25 * 60 * MIN);
    expect((await verifier(vieux)).location).toContain('error=token_expired');
    expect(await actif(email)).toBe(false);
    const a = await verifier(lien);
    expect(a.access).toBeTruthy();
    const b = await verifier(lien);
    expect(b.location).toContain('status=already_verified');
    expect(b.access).toBeUndefined();
  });

  it('MAIL-P0-E2E-08 — webhooks Resend : signature, rejeu, ordre indifférent, événement précoce', async () => {
    const { signSvixPayload } = await import('@/services/email/email-provider-events.service');
    const { POST } = await import('@/app/api/webhooks/resend/route');
    const secret = process.env.RESEND_WEBHOOK_SECRET!;
    const hook = (id: string, evt: Record<string, unknown>, opts: { sig?: string; ts?: number } = {}) => {
      const raw = JSON.stringify(evt);
      const ts = opts.ts ?? Math.floor(Date.now() / 1000);
      return POST(req('/api/webhooks/resend', {
        raw, headers: { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': opts.sig ?? signSvixPayload(secret, id, ts, raw) },
      }));
    };
    const email = `${uid('hook')}@proton.me`;
    await inscription(email);
    await settle();
    const [log] = await sql<{ id: number; provider_message_id: string }[]>`
      SELECT id, provider_message_id FROM email_logs WHERE recipient_email = ${email} AND status = 'sent'`;
    const msg = log.provider_message_id;
    const statut = async () => (await sql<{ delivery_status: string; delivered_at: Date | null; delivery_error: string | null }[]>`
      SELECT delivery_status, delivered_at, delivery_error FROM email_logs WHERE id = ${log.id}`)[0];
    const at = (s: number) => new Date(Date.now() + s * 1000).toISOString();

    // Signature fausse, absente, périmée : refus, aucun effet.
    expect((await hook('h-bad', { type: 'email.bounced', created_at: at(0), data: { email_id: msg } }, { sig: 'v1,AAAA' })).status).toBe(401);
    expect((await hook('h-old', { type: 'email.bounced', created_at: at(0), data: { email_id: msg } }, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await statut()).delivery_status).toBe('accepted');
    // Secret absent : 503 (Resend réessaiera), aucun effet.
    delete process.env.RESEND_WEBHOOK_SECRET;
    expect((await hook('h-nosecret', { type: 'email.bounced', created_at: at(0), data: { email_id: msg } })).status).toBe(503);
    process.env.RESEND_WEBHOOK_SECRET = secret;

    // Désordre : « delivered » (t+20) arrive avant « delivery_delayed » (t+10).
    expect((await hook('h-1', { type: 'email.delivered', created_at: at(20), data: { email_id: msg } })).status).toBe(200);
    expect((await hook('h-2', { type: 'email.delivery_delayed', created_at: at(10), data: { email_id: msg } })).status).toBe(200);
    expect((await statut()).delivery_status).toBe('delivered');
    expect((await statut()).delivered_at).not.toBeNull();
    // Rejeu du même événement : sans effet.
    const rejeu = await hook('h-1', { type: 'email.delivered', created_at: at(20), data: { email_id: msg } });
    expect(await rejeu.json()).toMatchObject({ received: true, duplicate: true });
    expect(await sql`SELECT 1 FROM email_provider_events WHERE event_id = 'h-1'`).toHaveLength(1);
    // Rejet ultérieur : prime (rang supérieur), motif conservé.
    await hook('h-3', { type: 'email.bounced', created_at: at(30), data: { email_id: msg, bounce: { type: 'Permanent', subType: 'General', message: '550 5.1.1 user unknown' } } });
    expect(await statut()).toMatchObject({ delivery_status: 'bounced', delivery_error: 'Permanent — General — 550 5.1.1 user unknown' });
    // `status = 'sent'` inchangé (consommateurs existants).
    expect((await sql<{ status: string }[]>`SELECT status FROM email_logs WHERE id = ${log.id}`)[0].status).toBe('sent');

    // Événement reçu AVANT la journalisation du message : appliqué ensuite.
    await hook('h-early', { type: 'email.delivered', created_at: at(5), data: { email_id: `em_57a_${etat.n + 1}` } });
    const email2 = `${uid('hook2')}@proton.me`;
    await inscription(email2);
    await settle();
    const [l2] = await sql<{ delivery_status: string; provider_message_id: string }[]>`
      SELECT delivery_status, provider_message_id FROM email_logs WHERE recipient_email = ${email2} AND status = 'sent'`;
    expect(l2.provider_message_id).toBe(`em_57a_${etat.n}`);
    expect(l2.delivery_status).toBe('delivered');
  });

  // ── Premium Duo ─────────────────────────────────────────────────────────
  async function jeton(user: { id: number; email: string }, accountId: number | null, role = 'USER') {
    const { generateAccessToken } = await import('@/lib/jwt');
    return generateAccessToken({
      id: user.id, email: user.email, role: role as never, planType: 'PREMIUM_DUO' as never, status: 'ACTIVE' as never,
      ...(accountId ? { currentAccountId: accountId } : {}), hasActiveAccount: true,
    });
  }
  async function titulaire() {
    const acc = await make.account({ plan: 'premium' });
    await sql`UPDATE users SET first_name = 'Camille', last_name = 'Durand', plan_type = 'PREMIUM_DUO', is_active = true, status = 'ACTIVE' WHERE id = ${acc.ownerUserId}`;
    const [d] = await sql<{ id: number }[]>`
      INSERT INTO duo_accounts (billing_owner_user_id, subscription_status) VALUES (${acc.ownerUserId}, 'ACTIVE') RETURNING id`;
    const [u] = await sql<{ id: number; email: string }[]>`SELECT id, email FROM users WHERE id = ${acc.ownerUserId}`;
    return { acc, duoId: d.id, user: u, token: await jeton(u, acc.id) };
  }
  const duoRow = async (id: number) => (await sql<{ sent: Date | null; first: Date | null; token: string | null }[]>`
    SELECT pending_invite_sent_at AS sent, duo_first_invite_sent_at AS first, pending_invite_token AS token FROM duo_accounts WHERE id = ${id}`)[0];

  it('MAIL-P0-E2E-09 — invitation Duo : échec non annoncé, invitation exploitable, reprise, bon destinataire, rejet visible', async () => {
    const t = await titulaire();
    const invite = `${uid('ami')}@proton.me`;
    const existant = await make.user({ email: invite }); // l'invité a déjà un compte
    const { POST, GET } = await import('@/app/api/duo/invitation/route');
    etat.plan.push({ name: 'application_error', message: 'Resend indisponible' });
    const res = await POST(req('/api/duo/invitation', { body: { email: invite }, cookie: `access_token=${t.token}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, emailAccepted: false, emailStatus: 'queued' });
    expect(body.inviteLink).toMatch(/\/duo\/join\/[0-9a-f]{64}$/); // invitation exploitable (copie du lien)
    expect(await duoRow(t.duoId)).toMatchObject({ sent: null, first: null });
    const g1 = await (await GET(req('/api/duo/invitation', { method: 'GET', cookie: `access_token=${t.token}` }))).json();
    expect(g1).toMatchObject({ status: 'PENDING', sentAt: null, email: { state: 'queued' } });

    const [j] = await sql<{ next_attempt_at: Date }[]>`SELECT next_attempt_at FROM transactional_email_jobs WHERE duo_id = ${t.duoId} ORDER BY id DESC LIMIT 1`;
    await retry(new Date(new Date(j.next_attempt_at).getTime() + 1_000));
    const apres = await duoRow(t.duoId);
    expect(apres.sent).not.toBeNull();
    expect(apres.first).not.toBeNull();
    expect(mailsA(invite)).toHaveLength(1);
    expect(mailsA(invite)[0].html).toContain(`/duo/join/${apres.token}`);
    const [log] = await sql<{ recipient_user_id: number; triggered_by_user_id: number; provider_message_id: string; metadata: string }[]>`
      SELECT recipient_user_id, triggered_by_user_id, provider_message_id, metadata FROM email_logs
       WHERE template_code = 'DUO_INVITATION' AND recipient_email = ${invite} AND status = 'sent'`;
    expect(log.recipient_user_id).toBe(existant.id); // destinataire, pas le titulaire
    expect(log.triggered_by_user_id).toBe(t.user.id);
    expect(log.metadata).not.toContain(apres.token!);
    const g2 = await (await GET(req('/api/duo/invitation', { method: 'GET', cookie: `access_token=${t.token}` }))).json();
    expect(g2.email.state).toBe('accepted');

    // Rejet par le serveur destinataire (webhook) : visible du titulaire.
    const { recordResendEvent } = await import('@/services/email/email-provider-events.service');
    await recordResendEvent(`bounce-${t.duoId}`, { type: 'email.bounced', created_at: new Date().toISOString(), data: { email_id: log.provider_message_id } });
    const g3 = await (await GET(req('/api/duo/invitation', { method: 'GET', cookie: `access_token=${t.token}` }))).json();
    expect(g3.email).toMatchObject({ state: 'failed' });
    expect(g3.email.reason).toMatch(/refusé/);

    // Envoi accepté d'emblée : annoncé comme tel.
    const t2 = await titulaire();
    const ok = await (await POST(req('/api/duo/invitation', { body: { email: `${uid('ami2')}@gmail.com` }, cookie: `access_token=${t2.token}` }))).json();
    expect(ok).toMatchObject({ success: true, emailAccepted: true, emailStatus: 'accepted' });
    expect((await duoRow(t2.duoId)).sent).not.toBeNull();
  });

  async function admin() {
    const u = await make.user({ email: `${uid('admin')}@verebona.test`, role: 'ADMIN' });
    await sql`UPDATE users SET role = 'ADMIN', is_active = true, status = 'ACTIVE' WHERE id = ${u.id}`;
    return jeton(u, null, 'ADMIN');
  }

  it('MAIL-P0-E2E-10 — renvoi Duo depuis le BO : échec rendu (502), succès rendu', async () => {
    const t = await titulaire();
    const invite = `${uid('bo')}@outlook.com`;
    const { POST } = await import('@/app/api/duo/invitation/route');
    await POST(req('/api/duo/invitation', { body: { email: invite }, cookie: `access_token=${t.token}` }));
    const tok = await admin();
    const { POST: renvoi } = await import('@/app/api/admin/users/[id]/resend-invitation/route');
    const ctx = { params: Promise.resolve({ id: String(t.user.id) }) };
    etat.plan.push({ name: 'application_error', message: 'Resend indisponible' });
    const ko = await renvoi(req(`/api/admin/users/${t.user.id}/resend-invitation`, { body: {}, cookie: `access_token=${tok}` }), ctx);
    expect(ko.status).toBe(502);
    expect(await ko.json()).toMatchObject({ code: 'EMAIL_NOT_ACCEPTED', emailStatus: 'queued' });
    const [j] = await sql<{ next_attempt_at: Date }[]>`SELECT next_attempt_at FROM transactional_email_jobs WHERE duo_id = ${t.duoId} ORDER BY id DESC LIMIT 1`;
    await sql`UPDATE transactional_email_jobs SET next_attempt_at = now() - interval '1 second' WHERE duo_id = ${t.duoId} AND status = 'pending'`;
    void j;
    const okr = await renvoi(req(`/api/admin/users/${t.user.id}/resend-invitation`, { body: {}, cookie: `access_token=${tok}` }), ctx);
    expect(okr.status).toBe(200);
    expect(await okr.json()).toMatchObject({ success: true, emailStatus: 'accepted' });
  });

  it('MAIL-P0-E2E-11 — BO : recherche par type et destinataire ; statut, erreur, identifiant Resend ; aucun jeton', async () => {
    const email = `${uid('bo-search')}@proton.me`;
    etat.plan.push({ name: 'validation_error', message: 'The preprod.verebona.fr domain is not verified.' });
    await inscription(email);
    await settle();
    const tok = await admin();
    const { GET } = await import('@/app/api/admin/communications/email-logs/route');
    const res = await GET(req(`/api/admin/communications/email-logs?type=email_verification&recipient=${encodeURIComponent(email.slice(0, 12))}&problems=1`, { method: 'GET', cookie: `access_token=${tok}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ligne = body.logs.find((l: { recipientEmail: string }) => l.recipientEmail === email);
    expect(ligne).toMatchObject({ templateCode: 'EMAIL_VERIFICATION', status: 'failed', errorMessage: '[validation_error] The preprod.verebona.fr domain is not verified.' });
    expect(ligne.job).toMatchObject({ status: 'pending', attempts: 1, maxAttempts: 6 });
    expect(body.pendingRequests.some((p: { recipientEmail: string }) => p.recipientEmail === email)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/token|verify-email|metadata/i);
    // Envoi accepté : identifiant Resend visible.
    await retry(new Date(Date.now() + 2 * MIN));
    const b2 = await (await GET(req(`/api/admin/communications/email-logs?recipient=${encodeURIComponent(email)}`, { method: 'GET', cookie: `access_token=${tok}` }))).json();
    expect(b2.logs[0]).toMatchObject({ status: 'sent', deliveryStatus: 'accepted' });
    expect(b2.logs[0].providerMessageId).toMatch(/^em_57a_/);
    // Configuration d'envoi effective : présence des secrets, jamais leur valeur.
    const conf = await (await GET(req('/api/admin/communications/email-logs?config=1', { method: 'GET', cookie: `access_token=${tok}` }))).json();
    expect(conf.config).toMatchObject({
      source: 'base', emailsEnabled: true, senderEmail: 'bonjour@preprod.verebona.fr', senderDomain: 'preprod.verebona.fr',
      apiKeyConfigured: true, webhookSecretConfigured: true, templates: { EMAIL_VERIFICATION: true, DUO_INVITATION: true },
    });
    expect(JSON.stringify(conf)).not.toContain(process.env.RESEND_WEBHOOK_SECRET!);
    expect(JSON.stringify(conf)).not.toContain('re_e2e_simule');
    // Non-administrateur : refusé.
    const t = await titulaire();
    expect((await GET(req('/api/admin/communications/email-logs', { method: 'GET', cookie: `access_token=${t.token}` }))).status).toBeGreaterThanOrEqual(401);
  });

  it('MAIL-P0-E2E-12 — autres e-mails inchangés : réinitialisation du mot de passe, confirmation légale', async () => {
    const u = await make.user({ email: `${uid('reset')}@proton.me` });
    const hash = await bcrypt.hash(PASSWORD, 4);
    await sql`UPDATE users SET is_active = true, status = 'ACTIVE', password_hash = ${hash} WHERE id = ${u.id}`;
    // Gabarit créé par l'amorçage en préproduction ; absent de la base e2e.
    await sql`INSERT INTO email_templates (type, subject, body, updated_at)
              SELECT 'PASSWORD_RESET', 'Réinitialisation', 'Bonjour {{firstName}}, Réinitialiser : {{resetUrl}}', now()
               WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE upper(type) = 'PASSWORD_RESET')`;
    const { startPasswordReset } = await import('@/services/auth/password-reset.service');
    await startPasswordReset(u.email);
    const [reset] = await sql<{ status: string; email_job_id: number | null; metadata: string; error_message: string | null }[]>`
      SELECT status, email_job_id, metadata, error_message FROM email_logs WHERE recipient_email = ${u.email} AND upper(template_code) = 'PASSWORD_RESET'`;
    expect(reset.status, reset.error_message ?? '').toBe('sent');
    expect(reset.email_job_id).toBeNull(); // envoi direct, inchangé
    expect(reset.metadata).not.toMatch(/token=(?!\[masqué\])/);
    expect(mailsA(u.email)).toHaveLength(1);

    await sql`INSERT INTO email_templates (type, subject, body, updated_at)
              SELECT 'LEGAL_CONFIRMATION', 'Vos conditions', 'Bonjour {{firstName}}, version {{legalVersionCode}} : {{legalPermalinkUrl}}', now()
               WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE upper(type) = 'LEGAL_CONFIRMATION')`;
    const { sendLegalConfirmationEmail } = await import('@/services/legal/legal-confirmation.service');
    const r = await sendLegalConfirmationEmail({ to: u.email, userId: u.id, firstName: 'A', versionCode: 'CGVU-57A', permalink: '/cgvu/CGVU-57A' } as never);
    expect(r.sent).toBe(true);
    const [legal] = await sql<{ status: string; metadata: string }[]>`
      SELECT status, metadata FROM email_logs WHERE recipient_email = ${u.email} AND template_code = 'LEGAL_CONFIRMATION'`;
    expect(legal.status).toBe('sent');
    expect(legal.metadata).toContain('/cgvu/CGVU-57A'); // permalien conservé (aucun masquage abusif)
  });
});
