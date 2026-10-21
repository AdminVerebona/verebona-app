/**
 * Lot 64A — e-mail au membre quand son accès Premium Duo prend fin (décision
 * PO du 16/10), sur PostgreSQL 16 réel (migration 0459, file durable 0405),
 * transport Resend SIMULÉ.
 *
 * L64-MAIL-E2E-01 Titulaire « Retirer » : UNE demande DUO_MEMBERSHIP_ENDED
 *                 (destinataire = membre, émetteur = titulaire), envoyée par
 *                 la reprise planifiée : e-mail au membre, journal
 *                 (recipient_user_id = membre, triggered_by = titulaire),
 *                 prénom du titulaire, jamais son adresse ni de motif.
 * L64-MAIL-E2E-02 Idempotence : sortie rejouée (endMembership, fermeture
 *                 rétractation rejouée) → aucune seconde demande ni e-mail ;
 *                 nouvelle adhésion puis nouvelle sortie → nouvel e-mail.
 * L64-MAIL-E2E-03 Déclencheurs système : rétractation (closeDuoForWithdrawal),
 *                 changement d'offre (applyPlanChange → Standard), suppression
 *                 du compte titulaire (Duo effacé en cascade : la demande
 *                 survit et part).
 * L64-MAIL-E2E-04 Pas d'e-mail DE FIN D'ACCÈS : membre qui part lui-même (lot
 *                 65A : il reçoit la confirmation DUO_MEMBERSHIP_LEFT, voir
 *                 l65), invitation d'une personne non inscrite annulée, impayé
 *                 simple (Duo non fermé).
 * L64-MAIL-E2E-05 Jamais bloquant : Resend en échec → sortie faite, demande
 *                 reprise puis acceptée (un seul e-mail) ; enregistrement
 *                 impossible (type refusé par la base) → sortie faite quand même.
 * L64-MAIL-E2E-06 Demande devenue sans objet : membre revenu dans le Duo,
 *                 compte du membre en suppression → close sans envoi ni
 *                 reprise. Lot 65A : e-mail VERROUILLÉ — une désactivation
 *                 inscrite en base (avant le verrou) est ignorée, il part.
 */
import type Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { uid } from '../factories';

const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule_64';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  process.env.APP_URL = 'https://app.e2e.verebona.test';
  return {
    calls: [] as Array<{ to: string; subject: string; html: string }>,
    plan: [] as Array<{ name: string; message: string } | null>,
  };
});
afterAll(() => { delete process.env.RESEND_API_KEY; });

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string; subject: string; html: string }) => {
        const err = etat.plan.length ? etat.plan.shift() : null;
        if (err) return { data: null, error: err };
        etat.calls.push(p);
        return { data: { id: `em_64_${etat.calls.length}` }, error: null };
      },
    };
  },
}));

const DUO_M = 'price_e2e_duo_l64_monthly';
const MIN = 60_000;

scenario('L64-MAIL', 'Duo : e-mail au membre quand son accès prend fin (déclencheurs, idempotence, non bloquant)', ({ sql, make }) => {
  beforeAll(async () => {
    const { getStripeCatalogContext } = await import('@/lib/stripe-client');
    const ctx = getStripeCatalogContext().catalogContext;
    const { pgCatalogStore } = await import('@/services/billing/catalog-store');
    const { versionRowFrom } = await import('@/services/billing/price-history.service');
    await pgCatalogStore.upsertPriceVersion(versionRowFrom(
      { id: DUO_M, livemode: false, product: 'prod_e2e_l64', lookup_key: null, unit_amount: 1990, currency: 'eur', tax_behavior: 'unspecified', active: true, recurring: { interval: 'month', interval_count: 1 } } as unknown as Stripe.Price,
      'premium_duo', 'monthly', { catalogContext: ctx }, 'e2e',
    ));
  });

  beforeEach(async () => {
    etat.plan.length = 0;
    process.env.RESEND_API_KEY = 're_e2e_simule_64';
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@preprod.verebona.fr', 'support@verebona.fr')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
    await sql`DELETE FROM communication_channel_settings WHERE event_code IN ('email:DUO_MEMBERSHIP_ENDED', 'email:DUO_MEMBERSHIP_LEFT')`;
    // Même base pour tous les fichiers : les demandes encore ouvertes laissées
    // par les scénarios précédents ne doivent pas consommer les réponses programmées.
    await sql`UPDATE transactional_email_jobs SET status = 'cancelled' WHERE status IN ('pending', 'sending')`;
  });

  /** Titulaire Premium Duo + second utilisateur actif (avec son propre compte Standard). */
  async function duoAvecMembre(duoStatus: 'ACTIVE' | 'UNPAID_RECOVERY' = 'ACTIVE') {
    const ownerEmail = `titulaire-${uid('l64')}@test.invalid`;
    const owner = await make.user({ email: ownerEmail, planType: 'PREMIUM_DUO' });
    await sql`UPDATE users SET first_name = 'Claire', last_name = 'Titulaire' WHERE id = ${owner.id}`;
    const acc = await make.account({ owner, plan: 'premium_duo' });
    const customer = `cus_${uid('l64')}`;
    const subId = `sub_${uid('l64')}`;
    await sql`UPDATE accounts SET plan_type = 'PREMIUM_DUO', subscription_status = 'ACTIVE', stripe_customer_id = ${customer},
                     stripe_subscription_id = ${subId}, max_members = 2 WHERE id = ${acc.id}`;
    await sql`UPDATE account_subscriptions SET stripe_customer_id = ${customer}, stripe_subscription_id = ${subId}, billing_period = 'monthly'
               WHERE account_id = ${acc.id}`;
    const [{ id: duoId }] = await sql<{ id: number }[]>`
      INSERT INTO duo_accounts (billing_owner_user_id, subscription_status, stripe_customer_id, stripe_subscription_id,
                                duo_subscription_started_at, activated_at)
      VALUES (${owner.id}, ${duoStatus}, ${customer}, ${subId}, now() - interval '2 days', now())
      RETURNING id`;
    await sql`UPDATE accounts SET duo_account_id = ${duoId} WHERE id = ${acc.id}`;
    const membre = await make.user({ planType: 'PREMIUM_DUO' });
    await sql`UPDATE users SET first_name = 'Marc' WHERE id = ${membre.id}`;
    await make.account({ owner: membre, plan: 'standard' });
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot, joined_at)
              VALUES (${duoId}, ${owner.id}, 'ACTIVE', 0, now()), (${duoId}, ${membre.id}, 'ACTIVE', 1, now())`;
    const [{ id: membershipId }] = await sql<{ id: number }[]>`SELECT id FROM duo_memberships WHERE duo_id = ${duoId} AND user_id = ${membre.id}`;
    return { ...acc, ownerEmail, customer, subId, duoId, membre, membershipId };
  }

  const jobsOf = async (userId: number) => sql<{
    id: number; status: string; user_id: number | null; duo_id: number | null; triggered_by_user_id: number | null;
    recipient_email: string; context: Record<string, unknown>; last_error: string | null; attempts: number; dedupe_key: string | null;
  }[]>`SELECT id, status, user_id, duo_id, triggered_by_user_id, recipient_email, context, last_error, attempts, dedupe_key
         FROM transactional_email_jobs WHERE kind = 'DUO_MEMBERSHIP_ENDED' AND user_id = ${userId} ORDER BY id`;
  const membershipStatus = async (id: number) => (await sql<{ status: string }[]>`SELECT status FROM duo_memberships WHERE id = ${id}`)[0]?.status;
  const retry = async (at = new Date(Date.now() + 1_000)) => (await import('@/services/email/transactional-email-jobs.service'))
    .runTransactionalEmailRetry({ now: () => at, deadline: Date.now() + 30_000 });
  const mailsTo = (email: string) => etat.calls.filter((c) => c.to === email);

  it('L64-MAIL-E2E-01 — « Retirer » : une demande, envoyée au membre par la reprise ; journal et contenu discrets', async () => {
    const c = await duoAvecMembre();
    const { removeDuoMember } = await import('@/services/duo/duo-exit.service');
    expect(await removeDuoMember(c.ownerUserId)).toMatchObject({ ok: true, status: 'REMOVED', memberUserId: c.membre.id });

    const [j, ...autres] = await jobsOf(c.membre.id);
    expect(autres).toHaveLength(0);
    expect(j).toMatchObject({
      status: 'pending', user_id: c.membre.id, duo_id: null, triggered_by_user_id: c.ownerUserId, recipient_email: c.membre.email,
      context: { duoId: c.duoId, membershipId: c.membershipId, ownerFirstName: 'Claire' },
    });
    expect(j.dedupe_key).toMatch(new RegExp(`^duo-membership-ended:${c.membershipId}:\\d+(\\.\\d+)?$`));
    expect(JSON.stringify(j.context)).not.toContain(c.ownerEmail);
    // Aucun appel au fournisseur pendant la sortie elle-même.
    expect(mailsTo(c.membre.email)).toHaveLength(0);

    await retry();
    const [m] = mailsTo(c.membre.email);
    expect(mailsTo(c.membre.email)).toHaveLength(1);
    expect(m.subject).toBe('Votre accès à l\'espace Premium Duo a pris fin');
    expect(m.html).toContain('Bonjour Marc');
    expect(m.html).toContain('partagiez avec Claire');
    expect(m.html).toContain('https://app.e2e.verebona.test/mon-compte');
    expect(m.html).toContain('https://app.e2e.verebona.test/mon-compte/offres');
    expect(m.html).not.toContain(c.ownerEmail);
    expect(m.html).not.toMatch(/rétract|impay|Titulaire/);
    expect(mailsTo(c.ownerEmail)).toHaveLength(0);

    const [after] = await jobsOf(c.membre.id);
    expect(after.status).toBe('accepted');
    const [log] = await sql<{ recipient_user_id: number; triggered_by_user_id: number; status: string; email_job_id: number; recipient_email: string }[]>`
      SELECT recipient_user_id, triggered_by_user_id, status, email_job_id, recipient_email FROM email_logs
       WHERE template_code = 'DUO_MEMBERSHIP_ENDED' AND email_job_id = ${j.id}`;
    expect(log).toMatchObject({ recipient_user_id: c.membre.id, triggered_by_user_id: c.ownerUserId, status: 'sent', recipient_email: c.membre.email });

    // Reprise rejouée : rien de plus.
    await retry(new Date(Date.now() + 10 * MIN));
    expect(mailsTo(c.membre.email)).toHaveLength(1);
  });

  it('L64-MAIL-E2E-02 — idempotence par sortie ; nouvelle adhésion puis nouvelle sortie → nouvel e-mail', async () => {
    const c = await duoAvecMembre();
    const { endMembership, removeDuoMember } = await import('@/services/duo/duo-exit.service');
    await removeDuoMember(c.ownerUserId);
    // Sortie rejouée directement (reprise, double traitement) : pas de 2e demande.
    await endMembership({ duoId: c.duoId, membershipId: c.membershipId, memberUserId: c.membre.id, status: 'REMOVED' });
    const { closeDuoForWithdrawal } = await import('@/services/duo/duo-withdrawal.service');
    await closeDuoForWithdrawal(c.id);
    await closeDuoForWithdrawal(c.id);
    expect(await jobsOf(c.membre.id)).toHaveLength(1);
    await retry();
    expect(mailsTo(c.membre.email)).toHaveLength(1);

    // Nouvelle adhésion (même ligne réactivée, nouvelle date d'entrée), nouvelle sortie.
    await sql`UPDATE duo_accounts SET subscription_status = 'ACTIVE' WHERE id = ${c.duoId}`;
    await sql`UPDATE duo_memberships SET status = 'ACTIVE', slot = 1, joined_at = now() + interval '1 second', left_at = NULL WHERE id = ${c.membershipId}`;
    await removeDuoMember(c.ownerUserId);
    const jobs = await jobsOf(c.membre.id);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].dedupe_key).not.toBe(jobs[1].dedupe_key);
    await retry();
    expect(mailsTo(c.membre.email)).toHaveLength(2);
  });

  it('L64-MAIL-E2E-03 — déclencheurs système : rétractation, passage Standard, suppression du compte titulaire', async () => {
    // Rétractation (lot 63) : fermeture du Duo.
    const a = await duoAvecMembre();
    const { closeDuoForWithdrawal } = await import('@/services/duo/duo-withdrawal.service');
    expect(await closeDuoForWithdrawal(a.id)).toMatchObject({ closed: true, removedMembers: 1 });
    expect(await jobsOf(a.membre.id)).toHaveLength(1);

    // Changement d'offre (Stripe / BO) : sortie de Premium Duo.
    const b = await duoAvecMembre();
    const { applyPlanChange } = await import('@/lib/plan-enforcement');
    await applyPlanChange({
      accountId: b.id, ownerUserId: b.ownerUserId, oldPlanType: 'PREMIUM_DUO', newPlanType: 'STANDARD', newSubStatus: 'ACTIVE',
      newPremiumUntil: null, newMaxMembers: 1, source: 'admin:e2e', sendEmails: false,
    });
    expect(await membershipStatus(b.membershipId)).toBe('REMOVED');
    expect(await jobsOf(b.membre.id)).toHaveLength(1);

    // Suppression du compte titulaire : Duo effacé en cascade, la demande reste.
    const d = await duoAvecMembre();
    const ref = `RET-L64-${uid('d')}`;
    await sql`INSERT INTO withdrawal_requests (public_reference, account_id, user_id, stripe_subscription_id, status, cancellation_status)
              VALUES (${ref}, ${d.id}, ${d.ownerUserId}, ${d.subId}, 'received', 'pending')`;
    const { deleteAccountNow } = await import('@/services/withdrawal/withdrawal-processor.service');
    expect(await deleteAccountNow({ accountId: d.id, userId: d.ownerUserId }, ref)).toBe('deleted');
    expect(await sql`SELECT 1 FROM duo_accounts WHERE id = ${d.duoId}`).toHaveLength(0);
    const [jd] = await jobsOf(d.membre.id);
    expect(jd).toMatchObject({ status: 'pending', context: { ownerFirstName: 'Claire' } });

    await retry();
    for (const x of [a, b, d]) {
      expect(mailsTo(x.membre.email)).toHaveLength(1);
      expect(mailsTo(x.membre.email)[0].html).not.toMatch(/rétract|impay|supprim[ée] son compte/);
    }
  });

  it('L64-MAIL-E2E-04 — pas d’e-mail : départ volontaire du membre, invitation annulée, impayé simple', async () => {
    // Le membre quitte lui-même : pas de « fin d'accès » (lot 65A : une
    // confirmation DUO_MEMBERSHIP_LEFT, seule, voir l65-duo-depart-email).
    const a = await duoAvecMembre();
    const { leaveDuo } = await import('@/services/duo/duo-exit.service');
    expect(await leaveDuo(a.membre.id)).toMatchObject({ ok: true, status: 'LEFT' });
    expect(await jobsOf(a.membre.id)).toHaveLength(0);

    // Invitation en attente d'une personne non inscrite, puis fin du partage.
    const owner = await make.user({ planType: 'PREMIUM_DUO' });
    const inviteEmail = `invite-${uid('l64')}@test.invalid`;
    await sql`INSERT INTO duo_accounts (billing_owner_user_id, subscription_status, pending_invite_email, pending_invite_token, pending_invite_token_expires_at)
              VALUES (${owner.id}, 'ACTIVE', ${inviteEmail}, ${uid('tok')}, now() + interval '7 days')`;
    const { endDuoSharing } = await import('@/lib/plan-enforcement');
    await endDuoSharing(owner.id);
    expect(await sql`SELECT 1 FROM transactional_email_jobs WHERE kind = 'DUO_MEMBERSHIP_ENDED' AND lower(recipient_email) = lower(${inviteEmail})`).toHaveLength(0);

    // Impayé simple : le Duo n'est pas fermé, le membre reste (mode récupération).
    const u = await duoAvecMembre('UNPAID_RECOVERY');
    await endDuoSharing(u.ownerUserId);
    const { removeDuoMember } = await import('@/services/duo/duo-exit.service');
    expect(await removeDuoMember(u.ownerUserId)).toMatchObject({ ok: false, error: 'DUO_UNPAID' });
    expect(await membershipStatus(u.membershipId)).toBe('ACTIVE');
    expect(await jobsOf(u.membre.id)).toHaveLength(0);

    await retry();
    expect(mailsTo(a.membre.email).filter((m) => /a pris fin/.test(m.subject))).toHaveLength(0);
    expect(mailsTo(inviteEmail)).toHaveLength(0);
    expect(mailsTo(u.membre.email)).toHaveLength(0);
  });

  it('L64-MAIL-E2E-05 — jamais bloquant : échec Resend repris (un seul e-mail) ; enregistrement impossible → sortie faite', async () => {
    const c = await duoAvecMembre();
    const { removeDuoMember } = await import('@/services/duo/duo-exit.service');
    await removeDuoMember(c.ownerUserId);
    etat.plan.push({ name: 'application_error', message: 'Service indisponible' });
    await retry();
    expect(await membershipStatus(c.membershipId)).toBe('REMOVED');
    const [j] = await jobsOf(c.membre.id);
    expect(j).toMatchObject({ status: 'pending', attempts: 1, last_error: expect.stringMatching(/indisponible/) });
    expect(mailsTo(c.membre.email)).toHaveLength(0);
    await retry(new Date(Date.now() + 2 * MIN));
    expect((await jobsOf(c.membre.id))[0].status).toBe('accepted');
    expect(mailsTo(c.membre.email)).toHaveLength(1);

    // Base qui refuse le type (migration 0459 non passée) : la sortie se fait quand même.
    const d = await duoAvecMembre();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sql`ALTER TABLE transactional_email_jobs DROP CONSTRAINT transactional_email_jobs_kind_check`;
    await sql`ALTER TABLE transactional_email_jobs ADD CONSTRAINT transactional_email_jobs_kind_check CHECK (kind IN ('EMAIL_VERIFICATION', 'DUO_INVITATION')) NOT VALID`;
    try {
      expect(await removeDuoMember(d.ownerUserId)).toMatchObject({ ok: true, status: 'REMOVED' });
    } finally {
      await sql`ALTER TABLE transactional_email_jobs DROP CONSTRAINT transactional_email_jobs_kind_check`;
      await sql`ALTER TABLE transactional_email_jobs ADD CONSTRAINT transactional_email_jobs_kind_check CHECK (kind IN ('EMAIL_VERIFICATION', 'DUO_INVITATION', 'DUO_MEMBERSHIP_ENDED', 'DUO_MEMBERSHIP_LEFT', 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER', 'DUO_INVITATION_DECLINED'))`; // lot 76D : liste complète (73B)
      err.mockRestore();
    }
    expect(await membershipStatus(d.membershipId)).toBe('REMOVED');
    expect((await sql<{ plan_type: string }[]>`SELECT plan_type FROM users WHERE id = ${d.membre.id}`)[0].plan_type).toBe('STANDARD');
    expect(await jobsOf(d.membre.id)).toHaveLength(0);
  });

  it('L64-MAIL-E2E-06 — demande sans objet : membre revenu, compte en suppression ; désactivation BO ignorée (verrou 65A)', async () => {
    const { removeDuoMember } = await import('@/services/duo/duo-exit.service');
    const back = await duoAvecMembre();
    await removeDuoMember(back.ownerUserId);
    await sql`UPDATE duo_memberships SET status = 'ACTIVE', left_at = NULL WHERE id = ${back.membershipId}`;

    const closing = await duoAvecMembre();
    await removeDuoMember(closing.ownerUserId);
    await sql`UPDATE users SET status = 'PENDING_DELETION' WHERE id = ${closing.membre.id}`;

    const off = await duoAvecMembre();
    await removeDuoMember(off.ownerUserId);
    await sql`INSERT INTO communication_channel_settings (event_code, channel, is_active)
              VALUES ('email:DUO_MEMBERSHIP_ENDED', 'email', false)
              ON CONFLICT DO NOTHING`;

    await retry();
    expect((await jobsOf(back.membre.id))[0]).toMatchObject({ status: 'cancelled', last_error: 'MEMBERSHIP_RESTORED' });
    expect((await jobsOf(closing.membre.id))[0]).toMatchObject({ status: 'cancelled', last_error: 'ACCOUNT_CLOSED' });
    // Lot 65A : e-mail verrouillé — la désactivation inscrite en base est ignorée.
    expect((await jobsOf(off.membre.id))[0]).toMatchObject({ status: 'accepted' });
    expect(mailsTo(off.membre.email)).toHaveLength(1);
    for (const x of [back, closing]) expect(mailsTo(x.membre.email)).toHaveLength(0);
    // Close : plus reprise.
    await retry(new Date(Date.now() + 10 * MIN));
    expect((await jobsOf(off.membre.id))[0].attempts).toBe(1);
    expect(mailsTo(off.membre.email)).toHaveLength(1);
  });
});
