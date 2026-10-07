/**
 * Exécution de la rétractation chez Stripe — CDC 6 §9 et §13.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE SERVICE NE LÈVE JAMAIS, ET CE N'EST PAS DE LA PARESSE
 *
 * Le §3.3 pose la règle : « la demande reste juridiquement enregistrée même si
 * Stripe ou un autre prestataire est temporairement indisponible ». La
 * déclaration est déjà écrite quand ce service s'exécute ; son échec ne doit
 * jamais la remettre en cause.
 *
 * Chaque incident est donc consigné dans `failure_code` et `failure_details`,
 * le statut passe à `failed`, et le balayage du §10 reprendra plus tard. À
 * aucun moment une exception ne remonte jusqu'à effacer une preuve.
 *
 * ── L'ORDRE EST IMPOSÉ (lot 32 : traitement et suppression IMMÉDIATS) ─────
 *
 *   1. COUPER LES ACCÈS, localement, AVANT tout appel Stripe : droits
 *      suspendus (`WITHDRAWN`, lecture seule) et sessions révoquées, même si
 *      Stripe est indisponible.
 *   2. ANNULER L'ABONNEMENT chez Stripe. Le §3.3 exige un effet immédiat et
 *      le §9.2 interdit `cancel_at_period_end`.
 *   3. REMBOURSER intégralement. Les identifiants Stripe et le contrat sont
 *      portés par la demande elle-même : le remboursement n'a besoin ni du
 *      compte ni de l'utilisateur.
 *   4. SUPPRIMER LE COMPTE IMMÉDIATEMENT (décision PO du 07/10/2026, Q2) —
 *      service de suppression existant (`executeScheduledDeletion`, délai 0),
 *      qui CONSERVE ce que la loi impose : factures (10 ans, L123-22 C. com.)
 *      détachées, demande et journal de rétractation (preuve de l'acte),
 *      preuves d'acceptation des CGVU pseudonymisées, registre RGPD.
 *      Faite à CHAQUE passage, que Stripe ait répondu ou non : la reprise
 *      Stripe ne dépend pas du compte.
 *
 * Un échec (Stripe, suppression) laisse la demande en `failed` : le balayage
 * planifié (`withdrawal-process`) la reprend automatiquement, sans action
 * manuelle. Rejouer est sans effet sur ce qui a déjà abouti (clés
 * d'idempotence Stripe, compte à rebours de suppression verrouillé).
 * L'e-mail d'au revoir est l'accusé de réception (`receipt.service`), envoyé
 * à la confirmation et renvoyé ici s'il n'est pas parti.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { db } from '@/db';
import { accountMemberships, accountSubscriptions, accounts, withdrawalRequests } from '@/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { getStripeServer } from '@/lib/stripe';
import {
  buildRefundPlan,
  type PaymentRecord,
  type RefundPlan,
} from './refund-calculator';
import { decideWithdrawalStatus, legacyLists, parseEntries, upsertRefund, type RefundEntry } from './refund-tracker';
import { executeScheduledDeletion, scheduleDeletion } from '@/services/account/scheduled-deletion.service';
import { listInvoicePaidCharges, PaymentLookupError } from '@/services/billing/stripe-payments';
import { recordWithdrawalEvent } from './withdrawal-journal.service';

export interface ProcessResult {
  status: 'completed' | 'processing' | 'failed' | 'skipped';
  cancellationStatus?: string;
  refundedAmount?: number;
  failureCode?: string;
  detail?: string;
  /** Suppression du compte (lot 32) : faite, déjà faite, ou en échec (reprise). */
  accountDeletion?: 'deleted' | 'already_deleted' | 'failed';
}

/** Délai au-delà duquel le balayage renvoie un accusé non remis (le parcours l'envoie d'abord). */
export const RECEIPT_RETRY_AFTER_MS = 2 * 60 * 1000;

/**
 * Traite une demande enregistrée.
 *
 * Idempotent : relancé sur la même demande, il ne réannule pas un abonnement
 * déjà annulé et ne recrée pas un remboursement déjà émis — les clés
 * d'idempotence Stripe s'en chargent.
 */
export async function processWithdrawal(
  publicReference: string,
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<ProcessResult> {
  const now = options.now ?? new Date();

  const [request] = await db
    .select()
    .from(withdrawalRequests)
    .where(eq(withdrawalRequests.publicReference, publicReference))
    .limit(1);

  if (!request) return { status: 'skipped', detail: 'REQUEST_NOT_FOUND' };
  if (!['received', 'processing', 'failed'].includes(request.status)) {
    return { status: 'skipped', detail: `STATUS_${request.status}` };
  }

  // 1 à 3 : accès coupés, annulation et remboursement Stripe.
  let stripeResult: ProcessResult;
  try {
    stripeResult = await processStripe(request, publicReference, now, options.stripe);
  } catch (e) {
    // Jamais d'exception jusqu'à l'appelant (voir l'en-tête) ; la
    // suppression du compte a lieu quand même.
    stripeResult = await recordFailure(publicReference, 'PROCESSING_ERROR', (e as Error).message, now);
  }

  // 4. Suppression immédiate du compte (lot 32), quel que soit Stripe.
  const deletion = await deleteAccountNow(request, publicReference, now);
  if (deletion === 'failed' && stripeResult.status !== 'failed') {
    // Stripe a abouti mais le compte est toujours là : la demande reste
    // `failed` pour que le balayage reprenne la suppression.
    await recordFailure(publicReference, 'ACCOUNT_DELETION_FAILED', 'Suppression du compte à reprendre.', now);
    stripeResult = { ...stripeResult, status: 'failed', failureCode: 'ACCOUNT_DELETION_FAILED' };
  }

  // E-mail d'au revoir (= accusé de réception) non remis : renvoi.
  await resendReceiptIfMissing(request, now);

  return { ...stripeResult, accountDeletion: deletion };
}

type WithdrawalRow = typeof withdrawalRequests.$inferSelect;

/** Étapes 1 à 3 : accès coupés, puis Stripe (annulation, remboursement). */
async function processStripe(
  request: WithdrawalRow,
  publicReference: string,
  now: Date,
  injectedStripe?: Stripe,
): Promise<ProcessResult> {

  // ══════════════════════════════════════════════════════════════════════
  // 1. SUSPENSION LOCALE DES DROITS — AVANT TOUT APPEL STRIPE (§3.4, §13)
  //
  // Elle intervenait après l'annulation Stripe : Stripe indisponible, ou
  // annulation refusée, et le traitement s'arrêtait AVANT enterRecoveryMode —
  // le compte gardait ses droits d'écriture alors que la rétractation était
  // confirmée. L'indisponibilité de Stripe doit empêcher l'exécution
  // externe, pas retarder la protection locale du compte.
  //
  // Idempotente : rejouée à chaque reprise, elle ne rend jamais de droits.
  // ══════════════════════════════════════════════════════════════════════
  if (request.accountId && (await enterRecoveryMode(request.accountId))) {
    // §18, élément 17 : accès coupés (première fois).
    await recordWithdrawalEvent({
      publicReference,
      eventType: 'EXPORT_ONLY_ENTERED',
      summary: 'Accès au compte coupés (lecture seule, sessions révoquées) avant sa suppression.',
    });
  }
  if (request.accountId) await revokeAccountSessions(request.accountId, publicReference);

  let stripe: Stripe;
  try {
    stripe = injectedStripe ?? getStripeServer();
  } catch (e) {
    return await recordFailure(publicReference, 'STRIPE_UNAVAILABLE', (e as Error).message, now);
  }

  // ── 3. Annulation immédiate chez Stripe (§9.2) ──────────────────────────
  // Stripe indisponible ou annulation refusée : échec consigné, reprise par
  // le balayage — les droits restent suspendus.
  let cancellationStatus = request.cancellationStatus;

  if (cancellationStatus === 'pending' && request.stripeSubscriptionId) {
    try {
      const subscription = await stripe.subscriptions.retrieve(request.stripeSubscriptionId);

      if (subscription.status === 'canceled') {
        // Déjà annulé — par un rejeu, ou par une action antérieure.
        cancellationStatus = 'cancelled';
      } else {
        await stripe.subscriptions.cancel(request.stripeSubscriptionId, {
          // §9.2 : le motif interne est porté dans les métadonnées Stripe
          // « lorsque possible », pour rapprocher les deux systèmes.
          cancellation_details: { comment: `withdrawal:${publicReference}` },
        });
        cancellationStatus = 'cancelled';
      }
      await recordWithdrawalEvent({
        publicReference,
        eventType: 'SUBSCRIPTION_CANCELLED',
        summary: `Abonnement ${request.stripeSubscriptionId} annulé chez Stripe.`,
        payload: { stripeSubscriptionId: request.stripeSubscriptionId },
      });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      // Un abonnement introuvable n'est pas un échec : il n'y a plus rien à
      // annuler, ce qui est le résultat recherché.
      if (err.code === 'resource_missing') {
        cancellationStatus = 'not_applicable';
      } else {
        await recordWithdrawalEvent({
          publicReference,
          eventType: 'SUBSCRIPTION_CANCEL_FAILED',
          result: 'failure',
          summary: `Annulation refusée par Stripe : ${err.message ?? 'motif inconnu'}.`,
          payload: { code: err.code ?? null },
        });
        await recordFailure(publicReference, 'CANCEL_FAILED', err.message ?? String(e), now);
        return { status: 'failed', failureCode: 'CANCEL_FAILED', detail: err.message };
      }
    }
  } else if (!request.stripeSubscriptionId) {
    cancellationStatus = 'not_applicable';
  }

  await db
    .update(withdrawalRequests)
    .set({ cancellationStatus, status: 'processing' })
    .where(eq(withdrawalRequests.publicReference, publicReference));

  // ── 4. Remboursement (§9.3, §9.4) ───────────────────────────────────────
  let plan: RefundPlan;
  try {
    const payments = await listContractPayments(
      stripe,
      request.stripeSubscriptionId,
      request.contractConcludedAt ?? request.requestedAt,
      publicReference,
    );
    plan = buildRefundPlan(
      payments,
      request.contractConcludedAt ?? request.requestedAt,
      publicReference,
    );
  } catch (e) {
    await recordFailure(publicReference, 'PAYMENTS_UNREADABLE', (e as Error).message, now);
    return { status: 'failed', failureCode: 'PAYMENTS_UNREADABLE' };
  }

  // §18, élément 13 : paiements identifiés.
  await recordWithdrawalEvent({
    publicReference,
    eventType: 'PAYMENTS_IDENTIFIED',
    summary:
      `${plan.instructions.length} paiement(s) remboursable(s) pour ${plan.totalAmount} centimes, ` +
      `${plan.excluded.length} écarté(s).`,
    payload: { retained: plan.instructions, excluded: plan.excluded },
  });

  if (plan.excluded.length > 0) {
    console.info(
      `[withdrawal] ${publicReference} : ${plan.excluded.length} paiement(s) écarté(s) — ` +
      plan.excluded.map((x) => `${x.paymentId} (${x.reason})`).join(', '),
    );
  }

  // Suivi individuel : entrées existantes, complétées par les remboursements
  // de CETTE demande retrouvés chez Stripe (reprise après interruption).
  let entries: RefundEntry[] = parseEntries(request.stripeRefundsJson);
  for (const p of plan.paymentsSeen ?? []) {
    for (const r of p.ownRefunds ?? []) {
      entries = upsertRefund(entries, { refundId: r.id, paymentId: p.id, amount: r.amount, status: r.status }, null, now);
    }
  }

  for (const instruction of plan.instructions) {
    try {
      const refund = await stripe.refunds.create(
        {
          ...(instruction.refundTarget === 'charge'
            ? { charge: instruction.paymentId }
            : { payment_intent: instruction.paymentId }),
          amount: instruction.amount,
          // §3.2 : remboursement intégral. `reason` documente l'opération
          // côté Stripe sans influer sur le montant.
          reason: 'requested_by_customer',
          metadata: { withdrawal_reference: publicReference },
        },
        // §9.4 : clé propre à la demande ET au paiement. Un rejeu retourne le
        // remboursement existant au lieu d'en créer un second.
        { idempotencyKey: instruction.idempotencyKey },
      );

      entries = upsertRefund(
        entries,
        { refundId: refund.id, paymentId: instruction.paymentId, amount: refund.amount ?? instruction.amount, status: refund.status ?? 'pending' },
        null,
        now,
      );

      await recordWithdrawalEvent({
        publicReference,
        eventType: 'REFUND_REQUESTED',
        summary: `Remboursement de ${instruction.amount} centimes demandé (${refund.status}).`,
        payload: {
          refundId: refund.id,
          paymentId: instruction.paymentId,
          amount: instruction.amount,
          status: refund.status,
        },
      });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      await recordWithdrawalEvent({
        publicReference,
        eventType: 'REFUND_REQUESTED',
        result: 'failure',
        summary: `Remboursement refusé sur ${instruction.paymentId} : ${err.message ?? 'motif inconnu'}.`,
        payload: { paymentId: instruction.paymentId, code: err.code ?? null },
      });
      // Les remboursements déjà émis sont conservés avant de consigner l'échec.
      const lists = legacyLists(entries);
      await db
        .update(withdrawalRequests)
        .set({ stripeRefundsJson: entries as never, stripeRefundIds: lists.ids, stripeRefundStatuses: lists.statuses, amountExpected: plan.totalAmount })
        .where(eq(withdrawalRequests.publicReference, publicReference));
      await recordFailure(
        publicReference,
        `REFUND_FAILED_${err.code ?? 'UNKNOWN'}`,
        `paiement ${instruction.paymentId} : ${err.message ?? String(e)}`,
        now,
      );
      return { status: 'failed', failureCode: 'REFUND_FAILED', detail: err.message };
    }
  }

  // Clôture sur les MONTANTS : total réussi === attendu (refund-tracker).
  const decision = decideWithdrawalStatus({ cancellationStatus, entries, amountExpected: plan.totalAmount });
  const finalStatus = decision.status;
  const refundedAmount = decision.amountRefunded;
  const lists = legacyLists(entries);
  const refundIds = entries.map((e) => e.refundId);

  await db
    .update(withdrawalRequests)
    .set({
      status: finalStatus,
      cancellationStatus,
      // Montant attendu : tout l'encaissé du contrat, net des remboursements
      // étrangers à la demande. Stable d'un passage à l'autre (les
      // remboursements de la demande n'en sont pas déduits).
      amountExpected: plan.totalAmount,
      amountRefunded: refundedAmount,
      currency: plan.currency,
      stripeRefundsJson: entries as never,
      stripeRefundIds: lists.ids,
      stripeRefundStatuses: lists.statuses,
      effectiveAt: request.effectiveAt ?? now,
      failureCode: finalStatus === 'failed' ? `WITHDRAWAL_${decision.reason ?? 'FAILED'}` : null,
      failureDetails: finalStatus === 'failed' ? `Remboursé ${refundedAmount} / attendu ${plan.totalAmount}.` : null,
    })
    .where(eq(withdrawalRequests.publicReference, publicReference));

  console.info(
    `[withdrawal] ${publicReference} : ${finalStatus} — abonnement ${cancellationStatus}, ` +
    `${refundIds.length} remboursement(s), ${refundedAmount} centimes réglés.`,
  );

  return {
    status: finalStatus === 'failed' ? 'failed' : finalStatus,
    cancellationStatus,
    refundedAmount,
  };
}

/**
 * Relève les paiements du contrat.
 *
 * Passe par les factures de l'abonnement plutôt que par la liste globale des
 * paiements du client : un compte peut porter d'autres achats — packs
 * d'analyses, par exemple — qui ne relèvent pas du contrat rétracté et ne
 * doivent surtout pas être remboursés.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FORMAT STRIPE BASIL, TOUTES LES FACTURES
 *
 * L'ancienne version lisait `invoice.payment_intent`, absent des factures au
 * format 2025-08-27.basil : chaque facture était ignorée, et la demande
 * concluait qu'il n'y avait RIEN à rembourser. Elle ne lisait en outre que
 * les 100 premières factures.
 *
 * Désormais :
 *   - toutes les factures de l'abonnement (pagination automatique) ;
 *   - pour chacune, ses règlements encaissés (`invoicePayments`) et la
 *     charge correspondante ;
 *   - les remboursements déjà présents sur chaque charge, séparés entre
 *     ceux de CETTE demande (reprise) et les autres (déduits) ;
 *   - une facture payée dont aucun règlement n'est identifiable, ou dont les
 *     règlements n'expliquent pas le montant payé, lève : la demande passe
 *     en échec / reprise, jamais en « rien à rembourser ».
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function listContractPayments(
  stripe: Stripe,
  stripeSubscriptionId: string | null,
  since: Date,
  publicReference: string,
): Promise<PaymentRecord[]> {
  if (!stripeSubscriptionId) return [];

  const payments: PaymentRecord[] = [];

  for await (const invoice of stripe.invoices.list({ subscription: stripeSubscriptionId, limit: 100 })) {
    // Seules les factures qui ont encaissé quelque chose comptent. Une
    // facture antérieure au contrat est écartée plus loin, paiement par
    // paiement (isRefundable), avec son motif.
    if (!invoice.id || (invoice.amount_paid ?? 0) <= 0) continue;

    const charges = await listInvoicePaidCharges(stripe, invoice.id);
    const encaisse = charges.reduce((sum, c) => sum + c.amount, 0);
    if (charges.length === 0 || encaisse < (invoice.amount_paid ?? 0)) {
      throw new PaymentLookupError(
        'INVOICE_PAYMENT_UNRESOLVED',
        `Facture ${invoice.id} : ${invoice.amount_paid} centimes payés, ${encaisse} identifiés.`,
      );
    }

    for (const c of charges) {
      const refunds: Stripe.Refund[] = [];
      for await (const r of stripe.refunds.list({ charge: c.chargeId, limit: 100 })) refunds.push(r);
      const own = refunds.filter((r) => r.metadata?.withdrawal_reference === publicReference);
      const others = refunds.filter(
        (r) => r.metadata?.withdrawal_reference !== publicReference && ['succeeded', 'pending'].includes(r.status ?? ''),
      );
      payments.push({
        id: c.paymentIntentId ?? c.chargeId,
        refundTarget: c.paymentIntentId ? 'payment_intent' : 'charge',
        invoiceId: invoice.id,
        amount: c.amount,
        amountRefunded: others.reduce((sum, r) => sum + r.amount, 0),
        currency: c.currency,
        captured: true,
        status: 'succeeded',
        createdAt: c.created,
        ownRefunds: own.map((r) => ({ id: r.id, amount: r.amount, status: r.status ?? 'pending' })),
      });
    }
  }

  // Sécurité : ne jamais considérer un paiement antérieur au contrat.
  return payments.filter((p) => p.createdAt.getTime() >= since.getTime() - 86_400_000);
}

/**
 * Sessions des membres du compte révoquées (lot 32 : « couper les accès »).
 * Best-effort : la suppression du compte, juste après, emporte de toute façon
 * utilisateurs et jetons de rafraîchissement.
 */
async function revokeAccountSessions(accountId: number, publicReference: string): Promise<void> {
  try {
    const [acc] = await db.select({ owner: accounts.ownerUserId }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
    const members = await db
      .select({ userId: accountMemberships.userId })
      .from(accountMemberships)
      .where(and(eq(accountMemberships.accountId, accountId), eq(accountMemberships.status, 'active'), isNotNull(accountMemberships.userId)));
    const ids = new Set<number>([acc?.owner, ...members.map((m) => m.userId)].filter((v): v is number => typeof v === 'number'));
    const { revokeUserSessionsNow } = await import('@/services/admin/account-status.service');
    for (const id of ids) await revokeUserSessionsNow(id, 'WITHDRAWAL');
  } catch (e) {
    console.error(`[withdrawal] ${publicReference} : révocation des sessions impossible — ${(e as Error).message}`);
  }
}

/**
 * Suppression IMMÉDIATE du compte (lot 32, décision PO Q2), par le service de
 * suppression existant : compte à rebours ouvert à délai nul (motif
 * WITHDRAWAL, portée compte), puis exécuté sur-le-champ. Ce service conserve
 * les factures (détachées), les demandes et le journal de rétractation, les
 * preuves d'acceptation pseudonymisées et le registre RGPD.
 *
 * Idempotente : compte déjà supprimé (lien de la demande tombé à NULL par la
 * cascade, ou compte introuvable) → `already_deleted`. Un échec est consigné
 * et repris par le balayage. Ne lève jamais.
 */
export async function deleteAccountNow(
  request: Pick<WithdrawalRow, 'accountId' | 'userId'>,
  publicReference: string,
  now: Date = new Date(),
): Promise<'deleted' | 'already_deleted' | 'failed'> {
  if (!request.accountId) return 'already_deleted';
  try {
    const [acc] = await db
      .select({ id: accounts.id, owner: accounts.ownerUserId })
      .from(accounts)
      .where(eq(accounts.id, request.accountId))
      .limit(1);
    if (!acc) return 'already_deleted';
    const userId = request.userId ?? acc.owner;
    const schedule = await scheduleDeletion({
      accountId: acc.id,
      userId,
      reason: 'WITHDRAWAL',
      confirmedAt: now,
      delayDays: 0,
    });
    const result = await executeScheduledDeletion(schedule.id, { now });
    if (result.status === 'executed') {
      await recordWithdrawalEvent({
        publicReference,
        eventType: 'DELETION_EXECUTED',
        summary: 'Compte et données supprimés immédiatement ; factures, demande de rétractation et preuves conservées.',
        payload: { scheduleId: schedule.id, preserved: result.preserved ?? null, deleted: result.deleted ?? null },
      });
      return 'deleted';
    }
    // Compte disparu entre-temps, ou exécution concurrente : vérifier.
    const [still] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, acc.id)).limit(1);
    if (!still) return 'already_deleted';
    await recordWithdrawalEvent({
      publicReference,
      eventType: 'DELETION_EXECUTED',
      result: 'failure',
      summary: `Suppression du compte non aboutie (${result.reason ?? result.status}) : reprise automatique.`,
      payload: { scheduleId: schedule.id, reason: result.reason ?? null },
    });
    return 'failed';
  } catch (e) {
    console.error(`[withdrawal] ${publicReference} : suppression du compte impossible — ${(e as Error).message}`);
    await recordWithdrawalEvent({
      publicReference,
      eventType: 'DELETION_EXECUTED',
      result: 'failure',
      summary: `Suppression du compte impossible : ${(e as Error).message.slice(0, 300)}.`,
    }).catch(() => undefined);
    return 'failed';
  }
}

/** Renvoi de l'accusé de réception / e-mail d'au revoir s'il n'est pas parti. */
async function resendReceiptIfMissing(request: WithdrawalRow, now: Date): Promise<void> {
  if (request.receiptSentAt || !request.receiptEmail) return;
  if (now.getTime() - request.requestedAt.getTime() < RECEIPT_RETRY_AFTER_MS) return;
  try {
    const decl = request.declarationSnapshotJson ? JSON.parse(request.declarationSnapshotJson) : null;
    const shown = (decl?.displayedSummary ?? {}) as Record<string, unknown>;
    const { sendWithdrawalReceipt } = await import('./receipt.service');
    await sendWithdrawalReceipt({
      publicReference: request.publicReference,
      to: request.receiptEmail,
      userId: null,
      firstName: request.consumerFirstName ?? '',
      lastName: request.consumerLastName ?? '',
      requestedAt: request.requestedAt,
      summary: {
        offerLabel: String(shown.offerLabel ?? 'Verebona'),
        billingPeriodLabel: String(shown.billingPeriodLabel ?? '—'),
        amountLabel: String(shown.amountLabel ?? 'à déterminer'),
      },
    });
  } catch (e) {
    console.error(`[withdrawal] ${request.publicReference} : renvoi de l'accusé impossible — ${(e as Error).message}`);
  }
}

/**
 * Coupe les droits du compte dès la confirmation (§13).
 *
 * Réutilise le statut `readonly` déjà connu du moteur de droits : plus
 * aucune écriture. Lot 32 : ce n'est plus une période de récupération de 30
 * jours mais l'état transitoire de quelques instants qui précède la
 * suppression immédiate (ou sa reprise si elle échoue).
 */
export async function enterRecoveryMode(accountId: number): Promise<boolean> {
  const [before] = await db
    .select({ s: accounts.subscriptionStatus })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  await db
    .update(accountSubscriptions)
    .set({ status: 'readonly', cancelAtPeriodEnd: false, updatedAt: new Date() })
    .where(eq(accountSubscriptions.accountId, accountId));

  await db
    .update(accounts)
    .set({ subscriptionStatus: 'WITHDRAWN', updatedAt: new Date() })
    .where(eq(accounts.id, accountId));

  // Les droits ne sont pas mis en cache (lus à chaque contrôle) ; les
  // lectures en cache du compte sur cette instance sont oubliées pour que
  // l'accueil et les compteurs reflètent tout de suite la récupération.
  const { invalidateAccountReadCache } = await import('@/lib/server-cache');
  invalidateAccountReadCache(accountId);

  return before?.s !== 'WITHDRAWN';
}

async function recordFailure(
  publicReference: string,
  code: string,
  detail: string,
  now: Date,
): Promise<ProcessResult> {
  await db
    .update(withdrawalRequests)
    .set({ status: 'failed', failureCode: code, failureDetails: detail.slice(0, 1000) })
    .where(eq(withdrawalRequests.publicReference, publicReference));

  console.error(`[withdrawal] ${publicReference} : ${code} — ${detail}`);
  return { status: 'failed', failureCode: code, detail };
}
