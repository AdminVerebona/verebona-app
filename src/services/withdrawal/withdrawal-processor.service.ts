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
 *   1. ANNULER L'ABONNEMENT. Le §3.3 exige un effet immédiat et le §9.2
 *      interdit `cancel_at_period_end` : un renouvellement facturé après une
 *      rétractation serait une faute lourde.
 *   2. SUSPENDRE LES DROITS. Le compte passe en `withdrawal_recovery` (§13).
 *   3. PLANIFIER LA SUPPRESSION à trente jours (§13.3).
 *   4. REMBOURSER. En dernier, parce que c'est l'étape la plus susceptible
 *      d'échouer ou de rester en attente — et qu'elle ne doit pas retarder
 *      l'arrêt des prélèvements.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { db } from '@/db';
import { accountSubscriptions, accounts, withdrawalRequests } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getStripeServer } from '@/lib/stripe';
import {
  buildRefundPlan,
  aggregateStatus,
  type PaymentRecord,
  type RefundPlan,
} from './refund-calculator';
import { scheduleDeletion } from '@/services/account/scheduled-deletion.service';
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
  options: { now?: Date } = {},
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

  let stripe: Stripe;
  try {
    stripe = getStripeServer();
  } catch (e) {
    return await recordFailure(publicReference, 'STRIPE_UNAVAILABLE', (e as Error).message, now);
  }

  // ── 1. Annulation immédiate (§9.2) ──────────────────────────────────────
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

  // ── 2. Suspension des droits (§3.4, §13) ────────────────────────────────
  if (request.accountId) {
    await enterRecoveryMode(request.accountId);
    // §18, élément 17 : date de passage en export uniquement.
    await recordWithdrawalEvent({
      publicReference,
      eventType: 'EXPORT_ONLY_ENTERED',
      summary: 'Compte basculé en lecture et export seuls.',
    });
  }

  // ── 3. Suppression planifiée à trente jours (§13.3) ─────────────────────
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

  // ── 4. Remboursement (§9.3, §9.4) ───────────────────────────────────────
  let plan: RefundPlan;
  try {
    const payments = await listContractPayments(
      stripe,
      request.stripeSubscriptionId,
      request.contractConcludedAt ?? request.requestedAt,
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

  const refundIds: string[] = JSON.parse(request.stripeRefundIds ?? '[]');
  const refundStatuses: string[] = JSON.parse(request.stripeRefundStatuses ?? '[]');
  let refundedAmount = request.amountRefunded;

  for (const instruction of plan.instructions) {
    try {
      const refund = await stripe.refunds.create(
        {
          payment_intent: instruction.paymentId,
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

      refundIds.push(refund.id);
      refundStatuses.push(refund.status ?? 'pending');
      if (refund.status === 'succeeded') refundedAmount += instruction.amount;

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
      await recordFailure(
        publicReference,
        `REFUND_FAILED_${err.code ?? 'UNKNOWN'}`,
        `paiement ${instruction.paymentId} : ${err.message ?? String(e)}`,
        now,
      );
      return { status: 'failed', failureCode: 'REFUND_FAILED', detail: err.message };
    }
  }

  const finalStatus = aggregateStatus(
    cancellationStatus,
    refundStatuses,
    refundIds.length,
  );

  await db
    .update(withdrawalRequests)
    .set({
      status: finalStatus,
      cancellationStatus,
      amountExpected: plan.totalAmount > 0 ? plan.totalAmount : request.amountExpected,
      amountRefunded: refundedAmount,
      currency: plan.currency,
      stripeRefundIds: JSON.stringify(refundIds),
      stripeRefundStatuses: JSON.stringify(refundStatuses),
      effectiveAt: request.effectiveAt ?? now,
      failureCode: null,
      failureDetails: null,
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
 */
async function listContractPayments(
  stripe: Stripe,
  stripeSubscriptionId: string | null,
  since: Date,
): Promise<PaymentRecord[]> {
  if (!stripeSubscriptionId) return [];

  const invoices = await stripe.invoices.list({
    subscription: stripeSubscriptionId,
    limit: 100,
  });

  const payments: PaymentRecord[] = [];

  for (const invoice of invoices.data) {
    // `payment_intent` a quitté le type public d'Invoice dans les versions
    // récentes du SDK, tout en restant présent dans la charge utile. On y
    // accède donc par un accès non typé, plutôt que par un `as` que le
    // compilateur refuse à juste titre.
    const raw = invoice as unknown as Record<string, unknown>;
    const paymentIntentId = typeof raw.payment_intent === 'string' ? raw.payment_intent : null;
    if (!paymentIntentId) continue;

    const intent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge'],
    });

    const charge = intent.latest_charge as Stripe.Charge | null;

    payments.push({
      id: intent.id,
      amount: intent.amount_received || intent.amount,
      amountRefunded: charge?.amount_refunded ?? 0,
      currency: intent.currency,
      captured: charge ? charge.captured : intent.status === 'succeeded',
      status: intent.status,
      createdAt: new Date(intent.created * 1000),
    });
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
async function enterRecoveryMode(accountId: number): Promise<void> {
  await db
    .update(accountSubscriptions)
    .set({ status: 'readonly', cancelAtPeriodEnd: false, updatedAt: new Date() })
    .where(eq(accountSubscriptions.accountId, accountId));

  await db
    .update(accounts)
    .set({ subscriptionStatus: 'WITHDRAWN', updatedAt: new Date() })
    .where(eq(accounts.id, accountId));
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
