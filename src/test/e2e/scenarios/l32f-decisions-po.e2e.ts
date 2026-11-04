/**
 * Lot 32F — décisions PO du 07/10/2026 sur PostgreSQL réel.
 *
 *   PO-Q1  : délai de rétractation à partir du PAIEMENT (premier paiement de
 *            l'abonnement payant), pas de la création ;
 *   PO-Q2  : traitement IMMÉDIAT — droits payants coupés, remboursement
 *            intégral, reprise automatique d'un remboursement échoué,
 *            idempotence ; LOT 102A (décision PO du 31/10/2026) : le compte
 *            n'est PLUS supprimé — lecture seule, données conservées 90 jours
 *            (purge programmée, annulée par une nouvelle souscription) ;
 *   PO-Q11 : statuts officiels (migration 0278, rejouable) ;
 *   PO-Q18/Q19 : une notification par lot d'envoi réussi, tous comptes ;
 *   PO-Q25 : le rappel du matin se coupe par le réglage des notifications.
 */
import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';

const session = { userId: 0, currentAccountId: 0 as number | null };
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));

// Aucun envoi réel : l'accusé / e-mail d'au revoir est seulement relevé.
const emails: Array<{ templateCode: string; to: string; variables: Record<string, string> }> = [];
vi.mock('@/lib/email/email-service', () => ({
  emailService: {
    send: async (o: { templateCode: string; to: string; variables: Record<string, string> }) => { emails.push(o); return { success: true }; },
  },
}));

// Stripe simulé : un paiement de 59 € ; le remboursement échoue au premier passage.
const JOUR = 24 * 3600 * 1000;
const stripeState = { refundFails: true, refunds: [] as Array<{ id: string; amount: number; status: string; metadata: Record<string, string> }>, cancelled: 0 };
const iter = <T,>(items: T[]) => (async function* () { for (const i of items) yield i; })();
const fakeStripe = {
  subscriptions: {
    retrieve: async () => ({ status: stripeState.cancelled ? 'canceled' : 'active' }),
    cancel: async () => { stripeState.cancelled += 1; return { status: 'canceled' }; },
  },
  invoices: { list: () => iter([{ id: 'in_e2e', amount_paid: 5900, status: 'paid' }]) },
  invoicePayments: {
    list: () => iter([{
      id: 'inpay_e2e',
      payment: { type: 'payment_intent', payment_intent: { id: 'pi_e2e', latest_charge: {
        id: 'ch_e2e', status: 'succeeded', paid: true, amount: 5900, amount_captured: 5900, amount_refunded: 0,
        currency: 'eur', created: Math.floor((Date.now() - JOUR) / 1000), disputed: false, payment_intent: 'pi_e2e',
      } } },
    }]),
  },
  charges: { retrieve: async () => { throw new Error('non attendu'); } },
  paymentIntents: { retrieve: async () => { throw new Error('non attendu'); } },
  refunds: {
    list: () => iter(stripeState.refunds),
    create: async (p: { amount: number; metadata: Record<string, string> }) => {
      if (stripeState.refundFails) throw Object.assign(new Error('Stripe indisponible'), { code: 'api_error' });
      const r = { id: `re_${stripeState.refunds.length + 1}`, amount: p.amount, status: 'succeeded', metadata: p.metadata };
      stripeState.refunds.push(r);
      return r;
    },
  },
};
vi.mock('@/lib/stripe', () => ({ getStripeServer: () => fakeStripe }));

scenario('L32F', 'Décisions PO du 07/10 : rétractation, statuts, notifications', ({ sql, make }) => {
  async function abonne(opts: { paidDaysAgo: number | null; concludedDaysAgo: number | null }) {
    const acc = await make.account({ plan: 'premium' });
    const paid = opts.paidDaysAgo === null ? null : new Date(Date.now() - opts.paidDaysAgo * JOUR).toISOString();
    const concluded = opts.concludedDaysAgo === null ? null : new Date(Date.now() - opts.concludedDaysAgo * JOUR).toISOString();
    await sql`UPDATE account_subscriptions
                 SET billing_period = 'yearly', contract_concluded_at = ${concluded}, first_billed_at = ${paid}
               WHERE account_id = ${acc.id}`;
    session.userId = acc.ownerUserId;
    session.currentAccountId = acc.id;
    return acc;
  }

  async function eligibilite() {
    const { GET } = await import('@/app/api/withdrawal/eligibility/route');
    const res = await GET(new NextRequest('http://localhost/api/withdrawal/eligibility'));
    expect(res.status).toBe(200);
    return res.json();
  }

  async function confirmer(idempotencyKey: string) {
    const { POST } = await import('@/app/api/withdrawal/confirm/route');
    return POST(new NextRequest('http://localhost/api/withdrawal/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Geo', lastName: 'M', receiptEmail: 'geo@test.invalid', idempotencyKey }),
    }));
  }

  // ── PO-Q1 ──────────────────────────────────────────────────────────────────

  it('PO-Q1 — abonnement démarré il y a 20 jours mais payé il y a 2 jours : rétractation proposée (délai au paiement)', async () => {
    await abonne({ paidDaysAgo: 2, concludedDaysAgo: 20 });
    const body = await eligibilite();
    expect(body.offerWithdrawal).toBe(true);
    expect(new Date(body.contract.paidAt).getTime()).toBeGreaterThan(Date.now() - 3 * JOUR);
  });

  it('PO-Q1 — payé il y a 21 jours : délai clos (409 à la confirmation) ; aucun paiement : aucun contrat payant', async () => {
    // 21 jours et non 16 : un délai qui finit un samedi, un dimanche ou un
    // jour férié est prorogé au jour ouvrable suivant (fenêtre encore
    // ouverte à J+16 selon le jour de la semaine).
    const acc = await abonne({ paidDaysAgo: 21, concludedDaysAgo: 21 });
    expect((await eligibilite()).reason).toBe('DEADLINE_PASSED');
    const res = await confirmer(`wd-clos-${acc.id}`);
    expect(res.status).toBe(409);
    expect(await sql`SELECT 1 FROM withdrawal_requests WHERE account_id = ${acc.id}`).toHaveLength(0);

    await abonne({ paidDaysAgo: null, concludedDaysAgo: null });
    const sansPaiement = await eligibilite();
    expect(sansPaiement.offerWithdrawal).toBe(false);
    expect(sansPaiement.reason).toBe('NO_PAID_CONTRACT');
  });

  // ── PO-Q2 ──────────────────────────────────────────────────────────────────

  it('PO-Q2 / L102A — confirmation : abonnement annulé, compte en LECTURE SEULE et CONSERVÉ (purge à +90 jours), accusé ; remboursement échoué repris automatiquement ; idempotent', async () => {
    stripeState.refundFails = true;
    stripeState.refunds = [];
    stripeState.cancelled = 0;
    emails.length = 0;
    const acc = await abonne({ paidDaysAgo: 1, concludedDaysAgo: 1 });
    await sql`UPDATE accounts SET stripe_subscription_id = 'sub_e2e', stripe_customer_id = 'cus_e2e' WHERE id = ${acc.id}`;
    const [facture] = await sql<{ id: number }[]>`
      INSERT INTO invoices (account_id, user_id, stripe_invoice_id, stripe_customer_id, amount, currency, status)
      VALUES (${acc.id}, ${acc.ownerUserId}, ${`in_e2e_${acc.id}`}, 'cus_e2e', 5900, 'eur', 'paid') RETURNING id`;
    const bien = await make.asset(acc);
    await make.assetFile(acc, { assetId: bien.id });

    const cle = `wd-e2e-${acc.id}`;
    const res = await confirmer(cle);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ accountAfterWithdrawal: 'read_only_retention', processing: 'done', alreadyRecorded: false });
    expect(body.dataExportDeadlineAt).toBeUndefined();

    // Lot 102A : RIEN n'est supprimé — compte en lecture seule, données conservées.
    expect(await sql`SELECT 1 FROM accounts WHERE id = ${acc.id}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM users WHERE id = ${acc.ownerUserId} AND status = 'ACTIVE'`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM assets WHERE id = ${bien.id}`).toHaveLength(1);
    const [etat] = await sql<{ s: string; r: string }[]>`
      SELECT a.subscription_status AS s, sub.status AS r FROM accounts a JOIN account_subscriptions sub ON sub.account_id = a.id WHERE a.id = ${acc.id}`;
    expect(etat).toEqual({ s: 'WITHDRAWN', r: 'readonly' });
    const { getEntitlements } = await import('@/services/entitlements.service');
    expect(await getEntitlements(acc.id)).toMatchObject({ canWrite: false, canRead: true, premiumFeatures: false });
    // Purge programmée à +90 jours (motif RETRACTATION), origine système : aucune demande RGPD.
    const [purge] = await sql<{ reason: string; origin: string; scheduled_at: Date; confirmed_at: Date }[]>`
      SELECT reason, origin, scheduled_at, confirmed_at FROM scheduled_account_deletions WHERE account_id = ${acc.id} AND status = 'SCHEDULED'`;
    expect(purge).toMatchObject({ reason: 'WITHDRAWAL', origin: 'system' });
    expect(Math.round((new Date(purge.scheduled_at).getTime() - new Date(purge.confirmed_at).getTime()) / JOUR)).toBe(90);
    // Facture toujours rattachée au compte (conservé).
    const [f] = await sql<{ account_id: number | null }[]>`SELECT account_id FROM invoices WHERE id = ${facture.id}`;
    expect(f).toEqual({ account_id: acc.id });
    const [demande] = await sql<{ public_reference: string; status: string; account_id: number | null; failure_code: string | null; data_export_deadline_at: Date | null; cancellation_status: string }[]>`
      SELECT public_reference, status, account_id, failure_code, data_export_deadline_at, cancellation_status
        FROM withdrawal_requests WHERE idempotency_key = ${cle}`;
    expect(demande).toMatchObject({ account_id: acc.id, status: 'failed', cancellation_status: 'cancelled', data_export_deadline_at: null });
    expect(demande.failure_code).toMatch(/^REFUND_FAILED/);
    const journal = await sql<{ event_type: string; result: string }[]>`
      SELECT event_type, result FROM withdrawal_events WHERE public_reference = ${demande.public_reference} ORDER BY id`;
    expect(journal.map((e) => e.event_type)).toEqual(expect.arrayContaining(['DECLARATION_RECEIVED', 'EXPORT_ONLY_ENTERED', 'SUBSCRIPTION_CANCELLED', 'DELETION_SCHEDULED']));
    expect(journal.map((e) => e.event_type)).not.toContain('DELETION_EXECUTED');
    // Accusé envoyé une fois, sans lien de suivi ; conservation annoncée.
    expect(emails.filter((e) => e.templateCode === 'WITHDRAWAL_RECEIPT')).toHaveLength(1);
    expect(emails[0].variables.trackingUrl).toBeUndefined();
    expect(emails[0].variables.retentionDays).toBe('90');
    const [modele] = await sql<{ body: string; subject: string }[]>`SELECT body, subject FROM email_templates WHERE type = 'WITHDRAWAL_RECEIPT'`;
    expect(modele.body).toContain('<strong>lecture seule</strong>');
    expect(modele.body).not.toContain('sont <strong>supprimés</strong>');
    expect(modele.subject).not.toMatch(/supprim/);
    expect(modele.body).not.toContain('{{trackingUrl}}');

    // Double soumission : même déclaration, rien de nouveau.
    const bis = await confirmer(cle);
    expect(bis.status).toBe(200);
    expect(await bis.json()).toMatchObject({ publicReference: demande.public_reference, alreadyRecorded: true });
    expect(await sql`SELECT 1 FROM withdrawal_requests WHERE idempotency_key = ${cle}`).toHaveLength(1);

    // Reprise AUTOMATIQUE par la tâche planifiée : remboursement intégral.
    stripeState.refundFails = false;
    const { runWithdrawalSweep } = await import('@/services/withdrawal/withdrawal-sweep.job');
    await runWithdrawalSweep();
    const [apres] = await sql<{ status: string; amount_refunded: number; amount_expected: number }[]>`
      SELECT status, amount_refunded, amount_expected FROM withdrawal_requests WHERE idempotency_key = ${cle}`;
    expect(apres).toEqual({ status: 'completed', amount_refunded: 5900, amount_expected: 5900 });
    expect(stripeState.refunds).toHaveLength(1);
    expect(stripeState.cancelled).toBe(1);
    // Rejouer ne rembourse pas deux fois.
    const { processWithdrawal } = await import('@/services/withdrawal/withdrawal-processor.service');
    expect((await processWithdrawal(demande.public_reference)).status).toBe('skipped');
    expect(stripeState.refunds).toHaveLength(1);
  });

  // ── PO-Q11 ─────────────────────────────────────────────────────────────────

  it('PO-Q11 — migration 0278 : anciennes valeurs converties, contrainte = liste officielle, rejouable', async () => {
    const acc = await make.account();
    const biens = await Promise.all(['EN_MAINTENANCE', 'HORS_SERVICE', 'EN_PANNE', 'EN_REPARATION', 'INACTIF', 'DETRUIT', 'VENDU', 'TRANSMIS'].map(async (s) => ({ s, b: await make.asset(acc) })));
    await sql`ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_status_check`;
    for (const { s, b } of biens) await sql`UPDATE assets SET status = ${s} WHERE id = ${b.id}`;

    const texte = await readFile(join(process.cwd(), 'src/db/migrations/0278_asset_status_official_list.sql'), 'utf-8');
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `passe ${passe}`).resolves.toBeDefined();
    } finally {
      cnx.release();
    }
    const lus = new Map((await sql<{ id: number; status: string }[]>`
      SELECT id, status FROM assets WHERE id IN ${sql(biens.map((x) => x.b.id))}`).map((r) => [r.id, r.status]));
    const attendu: Record<string, string> = {
      EN_MAINTENANCE: 'EN_SERVICE', HORS_SERVICE: 'EN_SERVICE', EN_PANNE: 'EN_SERVICE', EN_REPARATION: 'EN_SERVICE',
      INACTIF: 'EN_SERVICE', DETRUIT: 'ARCHIVED', VENDU: 'VENDU', TRANSMIS: 'TRANSMIS',
    };
    for (const { s, b } of biens) expect(lus.get(b.id), s).toBe(attendu[s]);
    const [{ def }] = await sql<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'assets_status_check'`;
    for (const s of ['EN_SERVICE', 'VENDU', 'TRANSMIS', 'ARCHIVED']) expect(def).toContain(`'${s}'`);
    expect(def).not.toContain('EN_MAINTENANCE');
    await expect(sql`UPDATE assets SET status = 'EN_PANNE' WHERE id = ${biens[0].b.id}`).rejects.toThrow(/assets_status_check/);
    await sql`UPDATE assets SET status = 'VENDU' WHERE id = ${biens[0].b.id}`;
  });

  // ── PO-Q18/Q19 ─────────────────────────────────────────────────────────────

  // Lot 108I (décision PO explicite, ticket « Notifications documents ») : la
  // notification d'ajout n'est plus émise (confirmation dans l'interface) —
  // couvert par `l108i-notifications-documents.e2e.ts`. Le scénario lot 32
  // « une notification par lot d'envoi » est retiré.

  // ── PO-Q25 ─────────────────────────────────────────────────────────────────

  it('PO-Q25 — l’e-mail du rappel du matin se désactive depuis le réglage des notifications', async () => {
    const acc = await make.account();
    const { resolveChannels } = await import('@/lib/notifications');
    const { NOTIFICATION_CATALOG } = await import('@/lib/notifications/catalog');
    const j7 = NOTIFICATION_CATALOG.DEADLINE_DUE_IN_7_DAYS!;
    expect((await resolveChannels(acc.ownerUserId, j7)).email).toBe(true);
    await sql`INSERT INTO notification_preferences (user_id, category, delivery_mode, channel, enabled)
              VALUES (${acc.ownerUserId}, 'deadlines', 'immediate', 'email', false)`;
    expect((await resolveChannels(acc.ownerUserId, j7)).email).toBe(false);
    const { buildPreferenceMatrix } = await import('@/lib/notifications/preference-matrix');
    const matrice = await buildPreferenceMatrix(acc.ownerUserId);
    expect(matrice.categories.find((c) => c.key === 'deadlines')?.immediate.email).toEqual({ enabled: false, locked: false, available: true }); // lot 79C : `available`
    expect(matrice.categories.find((c) => c.key === 'to_process')?.digest?.email.locked).toBe(false);
  });
});
