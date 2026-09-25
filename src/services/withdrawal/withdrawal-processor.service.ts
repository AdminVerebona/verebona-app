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
 * ── L'ORDRE EST IMPOSÉ ────────────────────────────────────────────────────
 *
 *   1. SUSPENDRE LES DROITS, localement, AVANT tout appel Stripe : le compte
 *      passe en `withdrawal_recovery` (§13) dès la confirmation, même si
 *      Stripe est indisponible.
 *   2. PLANIFIER LA SUPPRESSION à trente jours (§13.3), localement aussi.
 *   3. ANNULER L'ABONNEMENT chez Stripe. Le §3.3 exige un effet immédiat et
 *      le §9.2 interdit `cancel_at_period_end`. En échec : reprise ultérieure,
 *      droits toujours suspendus.
 *   4. REMBOURSER. En dernier, parce que c'est l'étape la plus susceptible
 *      d'échouer ou de rester en attente.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { db } from '@/db';
import { accountSubscriptions, accounts, withdrawalRequests } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getStripeServer } from '@/lib/stripe';
import {
  buildRefundPlan,
  type PaymentRecord,
  type RefundPlan,
} from './refund-calculator';
import { decideWithdrawalStatus, legacyLists, parseEntries, upsertRefund, type RefundEntry } from './refund-tracker';
import { scheduleDeletion } from '@/services/account/scheduled-deletion.service';
import { listInvoicePaidCharges, PaymentLookupError } from '@/services/billing/stripe-payments';
import { recordWithdrawalEvent } from './withdrawal-journal.service';

export interface ProcessResult {
  status: 'completed' | 'processing' | 'failed' | 'skipped';
  cancellationStatus?: string;
  refundedAmount?: number;
  failureCode?: string;
  detail?: string;
}

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
    // §18, élément 17 : date de passage en export uniquement (première fois).
    await recordWithdrawalEvent({
      publicReference,
      eventType: 'EXPORT_ONLY_ENTERED',
      summary: 'Compte basculé en lecture et export seuls.',
    });
  }

  // ── 2. Suppression planifiée à trente jours (§13.3) — locale, elle aussi ─
  if (request.accountId && request.userId) {
    await scheduleDeletion({
      accountId: request.accountId,
      userId: request.userId,
      reason: 'WITHDRAWAL',
      confirmedAt: request.confirmedAt ?? request.requestedAt,
    }).then((schedule) => recordWithdrawalEvent({
      publicReference,
      eventType: 'DELETION_SCHEDULED',
      summary: `Suppression des données planifiée au ${schedule.scheduledAt.toISOString()}.`,
      payload: { scheduledAt: schedule.scheduledAt.toISOString() },
    })).catch((e) => {
      // Une suppression non planifiée est un incident de conformité, pas une
      // raison d'interrompre le remboursement.
      console.error(
        `[withdrawal] ${publicReference} : suppression non planifiée — ${(e as Error).message}`,
      );
    });
  }

  let stripe: Stripe;
  try {
    stripe = options.stripe ?? getStripeServer();
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
 * Bascule le compte en récupération après rétractation (§13).
 *
 * Réutilise le statut `readonly` déjà connu du moteur de droits : lecture,
 * export et nouvelle souscription restent ouverts, l'écriture est fermée —
 * exactement le périmètre des §13.1 et §13.2. Introduire un statut distinct
 * imposerait de le traiter dans chaque contrôle d'accès existant, avec le
 * risque d'en oublier un et d'y laisser passer une écriture.
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

  // Droits en cache (60 s) : invalidés pour que le refus soit immédiat.
  const { serverCacheDeleteByPrefix } = await import('@/lib/server-cache');
  serverCacheDeleteByPrefix(`verebona:entitlements:${accountId}`);
  serverCacheDeleteByPrefix(`grace:${accountId}`);

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
