import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { recordPaidSubscriptionAcceptance } from '@/services/legal/legal-subscription.hook';
import {
    handleRefundEvent,
    handleSubscriptionCancelled,
} from '@/services/withdrawal/withdrawal-webhook.service';
import { cancelDeletion } from '@/services/account/scheduled-deletion.service';
import { db } from '@/db';
import {
  accounts,
  duoAccounts,
  duoMemberships,
  users,
  subscriptionHistory,
  stripeWebhookLogs,
  dunningEvents,
  accountSubscriptions,
} from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { sendDowngradeToStandardEmail } from '@/lib/email/billing-emails';
import { getStripeServer } from '@/lib/stripe';
import {
  getInvoiceSubscriptionId,
  syncSubscriptionById,
  syncSubscriptionFromStripe,
} from '@/services/billing/subscription-sync.service';
import { applyScheduledChange } from '@/services/plan-change.service';
import { trackFunnelEvent } from '@/services/funnel-analytics.service';
import { enforceStandardLimits } from '@/lib/plan-enforcement';
import { grantReferralRewardForFirstBilling } from '@/services/commercial-model.service';
import { emit } from '@/lib/notifications';

// ─── Init ──────────────────────────────────────────────────────────────────────

const getStripe = () => getStripeServer();

// ─── Webhook entry point ───────────────────────────────────────────────────────

/**
 * POST /api/billing/stripe-webhook
 *
 * Événements gérés :
 *   checkout.session.completed      → lie subscription → account/duo_account
 *   customer.subscription.created   → activate Premium or DUO
 *   customer.subscription.updated   → sync status (cancel_at_period_end, past_due, etc.)
 *   customer.subscription.deleted   → downgrade vers STANDARD local
 *   invoice.payment_succeeded       → renewal → update premiumUntil
 *   invoice.payment_failed          → grace period 15j (Premium) ou PAST_DUE_GRACE (DUO)
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();
  let event: Stripe.Event | undefined;

  try {
    const stripe = getStripe();
    const body = await request.text();
    const signature = request.headers.get('stripe-signature');

    if (!signature) {
      return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('[Stripe Webhook] STRIPE_WEBHOOK_SECRET absent : aucun événement ne peut être traité.');
      return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
    }

    try {
      event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
    } catch (err) {
      // Cause la plus fréquente : secret d'un autre endpoint ou d'un autre
      // mode (test/live) que celui qui a émis l'événement.
      console.error('[Stripe Webhook] Signature verification failed (vérifier STRIPE_WEBHOOK_SECRET et le mode de l\'endpoint):', err);
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    // Idempotency check with processed status
    const [existingLog] = await db
      .select()
      .from(stripeWebhookLogs)
      .where(eq(stripeWebhookLogs.eventId, event.id))
      .limit(1);

    if (existingLog) {
      if (existingLog.processed) {
        return NextResponse.json({ received: true, alreadyProcessed: true });
      } else {
        // If it was failed, delete it so we can re-process
        await db.delete(stripeWebhookLogs).where(eq(stripeWebhookLogs.eventId, event.id));
      }
    }

    // Insert log as PROCESSING (processed = false)
    await db.insert(stripeWebhookLogs).values({
      eventType: event.type,
      eventId: event.id,
      payload: JSON.stringify(event.data.object),
      processed: false,
      processingTimeMs: 0,
      createdAt: new Date(),
    });

    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription, event.type);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        // CDC rétractation §9.2 : confirme l'annulation, y compris lorsqu'elle
        // a été effectuée hors de l'application.
        await handleSubscriptionCancelled((event.data.object as Stripe.Subscription).id);
        break;

      // ── Suivi des remboursements de rétractation (CDC 6 §9.5, §9.6) ──
      //
      // Un remboursement Stripe n'aboutit pas à sa création : il part en
      // `pending` et devient `succeeded` — ou `failed` — plusieurs jours plus
      // tard. Sans ces événements, une demande resterait indéfiniment en
      // traitement et un échec passerait inaperçu.
      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed':
      case 'charge.refund.updated':
        await handleRefundEvent(event);
        break;
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      // ── Evenements ajoutes par le CDC §6.1 ──
      case 'invoice.paid':
        // Alias moderne de invoice.payment_succeeded : meme traitement.
        await handlePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.payment_action_required':
        await handlePaymentActionRequired(event.data.object as Stripe.Invoice);
        break;
      case 'charge.refunded':
        await handleChargeRefunded(event.data.object as Stripe.Charge);
        break;
      case 'charge.dispute.created':
        await handleDisputeCreated(event.data.object as Stripe.Dispute);
        break;
      default:
    }

    // Mark as PROCESSED
    await db
      .update(stripeWebhookLogs)
      .set({
        processed: true,
        processingTimeMs: Date.now() - startTime,
      })
      .where(eq(stripeWebhookLogs.eventId, event.id));

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error('[Stripe Webhook] Error:', error);
    try {
      // Try updating existing log to processed=false with error
      if (event?.id) {
        await db
          .update(stripeWebhookLogs)
          .set({
            processed: false,
            errorMessage: error instanceof Error ? error.message : 'Unknown error',
            processingTimeMs: Date.now() - startTime,
          })
          .where(eq(stripeWebhookLogs.eventId, event.id));
      }
    } catch (e) {
      // If that fails (e.g. because log was never inserted), write a fresh error log
      await db.insert(stripeWebhookLogs).values({
        eventType: 'unknown',
        eventId: `error-${Date.now()}`,
        payload: '{}',
        processed: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        processingTimeMs: Date.now() - startTime,
        createdAt: new Date(),
      }).onConflictDoNothing();
    }
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}

// ─── checkout.session.completed ───────────────────────────────────────────────

/**
 * Lie la subscription créée au bon compte (personal ou DUO).
 * Pour PREMIUM_DUO : lie aussi accounts.planType = 'PREMIUM_DUO' et maxMembers = 2.
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  const duoId = session.metadata?.duoId ? parseInt(session.metadata.duoId) : null;

  if (!customerId || !subscriptionId) {
    console.warn('[Webhook] checkout.session.completed: missing customer or subscription');
    return;
  }

  // L'ordre des événements Stripe n'est pas garanti : on relit l'abonnement
  // et on écrit l'état complet, sans attendre `customer.subscription.*`.
  const accountIdHint = Number(session.metadata?.accountId) || null;
  const result = await syncSubscriptionById(subscriptionId, {
    source: 'webhook:checkout.session.completed',
    accountIdHint,
  });

  if (!result) {
    console.error(`[Webhook] checkout.session.completed: abonnement ${subscriptionId} non synchronisé`);
    return;
  }

  if (duoId && result.planTier === 'premium_duo') {
    // Rattache le titulaire au duo (membership slot 0) et aligne le compte.
    await activateDuoOnAccount(duoId);
  }

  // CDC CGVU §8.2 et §10.1 : la souscription est rattachée à la version
  // applicable, et l'email de confirmation porte son permalien.
  //
  // Volontairement en dernier, et sans await bloquant sur l'échec : un
  // incident d'email ou de journal ne doit pas faire échouer un webhook
  // Stripe, qui serait alors rejoué et pourrait dupliquer des effets de bord
  // sur l'abonnement lui-même.
  await recordPaidSubscriptionAcceptance({
    accountId: result.accountId,
    stripeSubscriptionId: subscriptionId,
  });

  // CDC rétractation §13.3 et scénario n°21 : « annulation automatique de la
  // suppression si une nouvelle souscription est conclue ». Une souscription
  // réactive le compte ; laisser courir le compte à rebours détruirait les
  // données d'un client qui vient de repayer.
  await cancelDeletion(result.accountId, 'Nouvelle souscription conclue').catch((e) => {
    console.error('[Webhook] annulation de suppression impossible :', (e as Error).message);
  });
}

// ─── customer.subscription.created / updated ──────────────────────────────────

async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription,
  eventType: string
) {
  // État complet (offre, statut, périodicité, dates, identifiants) et effets
  // du changement d'offre (historique, emails, limites) : service commun.
  const result = await syncSubscriptionFromStripe({
    subscription,
    source: `webhook:${eventType}`,
  });

  if (!result || result.skipped) return;

  // Duo : rattachement du titulaire (membership slot 0).
  if (result.newPlanType === 'PREMIUM_DUO' && result.oldPlanType !== 'PREMIUM_DUO') {
    const duoIdFromMeta = subscription.metadata?.duoId ? parseInt(subscription.metadata.duoId) : null;
    const [account] = await db
      .select({ duoAccountId: accounts.duoAccountId })
      .from(accounts)
      .where(eq(accounts.id, result.accountId))
      .limit(1);
    const duoId = duoIdFromMeta ?? account?.duoAccountId ?? null;
    if (duoId) await activateDuoOnAccount(duoId);
  }
}

// ─── customer.subscription.deleted ────────────────────────────────────────────

/**
 * Stripe a définitivement annulé la subscription (impayée ou résiliée).
 * Premium/Standard/PREMIUM_DUO → STANDARD sur le compte lié.
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string;
  const subscriptionId = subscription.id;

  // ── DUO sub ? ──
  const [duoAccount] = await db
    .select()
    .from(duoAccounts)
    .where(eq(duoAccounts.stripeSubscriptionId, subscriptionId))
    .limit(1);

  if (duoAccount) {
    await db
      .update(duoAccounts)
      .set({ subscriptionStatus: 'CANCELED', updatedAt: new Date() })
      .where(eq(duoAccounts.id, duoAccount.id));

    // Downgrade le compte lié en STANDARD
    await downgradeDuoAccount(duoAccount.id);
    return;
  }

  // ── Premium sub ──
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.stripeCustomerId, customerId))
    .limit(1);

  if (!account) {
    console.error(`[Webhook] subscription.deleted: no account for customer ${customerId}`);
    return;
  }

  const oldPlanType = account.planType;

  await db
    .update(accounts)
    .set({
      planType: 'STANDARD',
      subscriptionTier: 'free',
      subscriptionStatus: 'EXPIRED',
      premiumUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, account.id));

  await db.insert(subscriptionHistory).values({
    userId: account.ownerUserId,
    accountId: account.id,
    oldTier: oldPlanType,
    newTier: 'STANDARD',
    oldPremiumUntil: account.premiumUntil,
    newPremiumUntil: null,
    source: 'webhook:customer.subscription.deleted',
    createdAt: new Date(),
  });

  // Résiliation d'abonnement (configurable, cloche + email par défaut, CDC §7.6).
  try {
    await emit({
      type: 'SUBSCRIPTION_CANCELLED',
      accountId: account.id,
      entityType: 'subscription',
      entityId: subscription.id,
      payload: {},
      dedupeKey: `account:subscription-cancelled:${subscription.id}`,
    });
  } catch (err) {
    console.error('[stripe-webhook] emit SUBSCRIPTION_CANCELLED échoué:', err);
  }

  // Sync users.planType so the badge matches
  if (oldPlanType !== 'STANDARD') {
    await db
      .update(users)
      .set({ planType: 'STANDARD', updatedAt: new Date() })
      .where(eq(users.id, account.ownerUserId));
  }

  if (oldPlanType !== 'STANDARD') {
    sendDowngradeToStandardEmail(account.ownerUserId).catch(console.error);
    await enforceStandardLimits(account.id, account.ownerUserId);
  }
}

// ─── invoice.payment_succeeded ────────────────────────────────────────────────

/**
 * Renouvellement réussi → met à jour premiumUntil, s'assure que le statut est ACTIVE.
 * Déclenche la récompense de parrainage lors de la première facturation du filleul.
 */
async function handlePaymentSucceeded(invoice: Stripe.Invoice) {
  // API 2025-08-27.basil : l'abonnement est sous `parent.subscription_details`.
  // L'ancien `invoice.subscription` étant absent, ce traitement sortait
  // toujours ici, sans jamais constater le paiement.
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) return; // paiement ponctuel, pas un abonnement

  const paidAt = invoice.status_transitions?.paid_at
    ? new Date(invoice.status_transitions.paid_at * 1000)
    : new Date();

  const result = await syncSubscriptionById(subscriptionId, {
    source: 'webhook:invoice.paid',
    paidAt,
  });
  if (!result || result.skipped) return;

  const accountId = result.accountId;

  // Garantit la date de première facturation, même si l'état avait été
  // synchronisé avant l'encaissement.
  await db
    .update(accountSubscriptions)
    .set({ firstBilledAt: sql`COALESCE(${accountSubscriptions.firstBilledAt}, ${paidAt.toISOString()}::timestamptz)` })
    .where(eq(accountSubscriptions.accountId, accountId));

  // Renouvellement (configurable). On ne notifie que les cycles de renouvellement
  // réels, pas le premier paiement (activation), pour ne pas sur-notifier.
  if (invoice.billing_reason === 'subscription_cycle') {
    try {
      await emit({
        type: 'SUBSCRIPTION_RENEWED',
        accountId,
        entityType: 'invoice',
        entityId: invoice.id,
        payload: { planCode: result.newPlanType },
        dedupeKey: `account:subscription-renewed:${invoice.id}`,
      });
    } catch (err) {
      console.error('[stripe-webhook] emit SUBSCRIPTION_RENEWED échoué:', err);
    }
  }

  if (invoice.id) {
    await grantReferralRewardForFirstBilling(accountId, invoice.id).catch((err: Error) => {
      console.error('[Webhook] referral reward grant failed:', err.message);
    });
  }

  // CDC §17 : paiement abouti, et denouement de l'essai.
  void (async () => {
    const [subRow] = await db
      .select({
        planCode: accountSubscriptions.planCode,
        billingPeriod: accountSubscriptions.billingPeriod,
        trialEndsAt: accountSubscriptions.trialEndsAt,
      })
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountId, accountId))
      .limit(1);

    await trackFunnelEvent({
      event: 'payment_succeeded',
      accountId,
      planCode: subRow?.planCode ?? null,
      billingPeriod: subRow?.billingPeriod ?? null,
    });

    if (invoice.billing_reason === 'subscription_create') {
      const expired = subRow?.trialEndsAt ? subRow.trialEndsAt.getTime() < Date.now() : false;
      await trackFunnelEvent({
        event: expired ? 'converted_after_expiry' : 'converted_before_expiry',
        accountId,
        planCode: subRow?.planCode ?? null,
        billingPeriod: subRow?.billingPeriod ?? null,
      });
    }
  })().catch((err: Error) => console.error('[Webhook] suivi analytique:', err.message));

  // CDC §10 : un changement d'offre ou de periodicite programme prend effet
  // au renouvellement, sans prorata.
  await applyScheduledChange(accountId).then((r) => {
    if (r.applied) {
      console.info('[Webhook] changement programme applique:', r.planCode, r.billingPeriod);
    }
  }).catch((err: Error) => {
    console.error('[Webhook] application du changement programme echouee:', err.message);
  });
}

// ─── invoice.payment_failed ───────────────────────────────────────────────────

/**
 * Premium : grace period 15 jours (subscriptionStatus = PAST_DUE_GRACE).
 * L'accès Premium est conservé pendant cette période.
 * Si Stripe abandonne → subscription.deleted → downgrade STANDARD.
 *
 * DUO : idem, grace deadline 15j stocké sur duo_accounts.
 */
async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const customerId = invoice.customer as string;
  const subscriptionId = getInvoiceSubscriptionId(invoice);

  if (!customerId) return;

  // ── DUO payment failed ──
  if (subscriptionId) {
    const [duoAccount] = await db
      .select()
      .from(duoAccounts)
      .where(eq(duoAccounts.stripeSubscriptionId, subscriptionId))
      .limit(1);

    if (duoAccount) {
      if (!duoAccount.firstPaymentFailedAt) {
        const now = new Date();
        const graceDeadline = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000);

        await db
          .update(duoAccounts)
          .set({
            subscriptionStatus: 'PAST_DUE_GRACE',
            firstPaymentFailedAt: now,
            graceDeadlineAt: graceDeadline,
            updatedAt: now,
          })
          .where(eq(duoAccounts.id, duoAccount.id));

        await db.insert(dunningEvents).values({
          duoId: duoAccount.id,
          stage: 'T0',
          sentAt: now,
        }).onConflictDoNothing();

        // Incident de paiement obligatoire pour le titulaire de la facturation Duo.
        if (duoAccount.billingOwnerUserId) {
          try {
            await emit({
              type: 'PAYMENT_FAILED',
              recipientUserIds: [duoAccount.billingOwnerUserId],
              entityType: 'invoice',
              entityId: invoice.id,
              payload: { duoId: duoAccount.id },
              dedupeKey: `account:payment-failed:${invoice.id}`,
            });
          } catch (err) {
            console.error('[stripe-webhook] emit PAYMENT_FAILED (duo) échoué:', err);
          }
        }
      }
      return;
    }
  }

  // ── Premium payment failed ──
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.stripeCustomerId, customerId))
    .limit(1);

  if (!account) {
    console.warn(`[Webhook] payment_failed: no account for customer ${customerId}`);
    return;
  }

  // Only enter grace period once
  if (account.subscriptionStatus !== 'PAST_DUE_GRACE') {
    const now = new Date();
    const graceEnds = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000);
    await db
      .update(accounts)
      .set({
        subscriptionStatus: 'PAST_DUE_GRACE',
        pastDueGraceStartedAt: now,
        pastDueGraceEndsAt: graceEnds,
        updatedAt: now,
      })
      .where(eq(accounts.id, account.id));

    // Incident de paiement obligatoire (cloche + email, CDC §7.6).
    try {
      await emit({
        type: 'PAYMENT_FAILED',
        accountId: account.id,
        entityType: 'invoice',
        entityId: invoice.id,
        payload: { accountId: account.id },
        dedupeKey: `account:payment-failed:${invoice.id}`,
      });
    } catch (err) {
      console.error('[stripe-webhook] emit PAYMENT_FAILED échoué:', err);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Set accounts.planType = 'PREMIUM_DUO', users.planType = 'PREMIUM_DUO', maxMembers = 2 when a PREMIUM_DUO sub becomes active.
 * Uses accounts.duoAccountId to find the linked account.
 */
async function activateDuoOnAccount(duoAccountId: number) {
  const [duo] = await db
    .select({
      billingOwnerUserId: duoAccounts.billingOwnerUserId,
      duoSubscriptionStatus: duoAccounts.subscriptionStatus,
    })
    .from(duoAccounts)
    .where(eq(duoAccounts.id, duoAccountId))
    .limit(1);

  const billingOwnerUserId = duo?.billingOwnerUserId;

  const [linked] = await db
    .select({ id: accounts.id, planType: accounts.planType, ownerUserId: accounts.ownerUserId, subscriptionStatus: accounts.subscriptionStatus })
    .from(accounts)
    .where(eq(accounts.duoAccountId, duoAccountId))
    .limit(1);

  const account = linked ?? (billingOwnerUserId
    ? (await db.select({ id: accounts.id, planType: accounts.planType, subscriptionStatus: accounts.subscriptionStatus }).from(accounts).where(eq(accounts.ownerUserId, billingOwnerUserId)).limit(1))[0]
    : null);

  if (account) {
    if (account.planType !== 'PREMIUM_DUO') {
      await db
        .update(accounts)
        .set({
          planType: 'PREMIUM_DUO',
          subscriptionTier: 'pro',
          maxMembers: 2,
          duoAccountId,
          
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, account.id));
    }
    // Also propagate duo subscription status / trial info to main account so /users/me and token logic see consistent state for owner
    const mappedAccountStatus = (() => {
      const ds = duo?.duoSubscriptionStatus;
      if (ds === 'ACTIVE') return 'ACTIVE';
      if (ds === 'TRIALING') return 'TRIALING';
      if (ds === 'PAST_DUE_GRACE') return 'PAST_DUE_GRACE';
      if (ds === 'UNPAID_RECOVERY') return 'UNPAID_RECOVERY';
      if (ds === 'CANCELED') return 'CANCELED';
      if (ds === 'EXPIRED') return 'EXPIRED';
      return account.subscriptionStatus || 'TRIALING'; // fallback for initial activation during trial
    })();
    if (account.subscriptionStatus !== mappedAccountStatus) {
      await db
        .update(accounts)
        .set({
          subscriptionStatus: mappedAccountStatus,
          
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, account.id));
    }
  }

  // Set users.planType = 'PREMIUM_DUO' on billing owner
  if (billingOwnerUserId) {
    await db
      .update(users)
      .set({ planType: 'PREMIUM_DUO', updatedAt: new Date() })
      .where(eq(users.id, billingOwnerUserId));

    // Ensure billing owner is in duo_memberships as slot 0
    const existing = await db
      .select({ id: duoMemberships.id })
      .from(duoMemberships)
      .where(and(eq(duoMemberships.duoId, duoAccountId), eq(duoMemberships.userId, billingOwnerUserId)))
      .limit(1);

    if (!existing.length) {
      await db.insert(duoMemberships).values({
        duoId: duoAccountId,
        userId: billingOwnerUserId,
        status: 'ACTIVE',
        slot: 0,
        invitedAt: new Date(),
        joinedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }
}

/**
 * Downgrade the account linked to a PREMIUM_DUO subscription back to STANDARD.
 * Removes the second member from accountMemberships.
 */
async function downgradeDuoAccount(duoAccountId: number) {
  const [linked] = await db
    .select({ id: accounts.id, ownerUserId: accounts.ownerUserId, planType: accounts.planType })
    .from(accounts)
    .where(eq(accounts.duoAccountId, duoAccountId))
    .limit(1);

  if (!linked) {
    // Fallback: find by billingOwner
    const [duo] = await db
      .select({ billingOwnerUserId: duoAccounts.billingOwnerUserId })
      .from(duoAccounts)
      .where(eq(duoAccounts.id, duoAccountId))
      .limit(1);

    if (duo) {
      const [byOwner] = await db
        .select({ id: accounts.id, ownerUserId: accounts.ownerUserId })
        .from(accounts)
        .where(eq(accounts.ownerUserId, duo.billingOwnerUserId))
        .limit(1);

      if (byOwner) {
        await performDuoDowngrade(byOwner.id, byOwner.ownerUserId);
      }
    }
    return;
  }

  await performDuoDowngrade(linked.id, linked.ownerUserId);
}

async function performDuoDowngrade(accountId: number, ownerUserId: number) {
  const oldPlanType = (await db.select({ planType: accounts.planType }).from(accounts).where(eq(accounts.id, accountId)).limit(1))[0]?.planType;

  await db
    .update(accounts)
    .set({
      planType: 'STANDARD',
      subscriptionTier: 'free',
      subscriptionStatus: 'EXPIRED',
      maxMembers: 1,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, accountId));

  // Reset users.planType = 'STANDARD' on billing owner
  await db
    .update(users)
    .set({ planType: 'STANDARD', updatedAt: new Date() })
    .where(eq(users.id, ownerUserId));

  // Reset users.planType = 'STANDARD' on all active Duo members (slot 1)
  const duoAccount = (await db.select({ id: duoAccounts.id }).from(duoAccounts).where(eq(duoAccounts.billingOwnerUserId, ownerUserId)).limit(1))[0];
  if (duoAccount) {
    const activeMembers = await db
      .select({ userId: duoMemberships.userId })
      .from(duoMemberships)
      .where(and(eq(duoMemberships.duoId, duoAccount.id), eq(duoMemberships.status, 'ACTIVE')));
    for (const m of activeMembers) {
      await db
        .update(users)
        .set({ planType: 'STANDARD', updatedAt: new Date() })
        .where(eq(users.id, m.userId));
    }
  }

  await db.insert(subscriptionHistory).values({
    userId: ownerUserId,
    accountId,
    oldTier: oldPlanType ?? 'PREMIUM_DUO',
    newTier: 'STANDARD',
    oldPremiumUntil: null,
    newPremiumUntil: null,
    source: 'webhook:customer.subscription.deleted:duo',
    createdAt: new Date(),
  });

  sendDowngradeToStandardEmail(ownerUserId).catch(console.error);
  await enforceStandardLimits(accountId, ownerUserId);

}

// ─── V4 Analyse rétroactive ────────────────────────────────────────────────────

/**
 * Déclenche l'analyse IA sur tous les documents non encore analysés du compte.
 * Exécuté en fire-and-forget lors du passage Standard → Premium.
 * Séquentiellement avec 2s de délai entre chaque pour ne pas saturer l'API Gemini.
 */
async function triggerRetroactiveAnalysis(accountId: number): Promise<void> {
  const { assetFiles: af } = await import('@/db/schema');
  const { isNull: drizzleIsNull } = await import('drizzle-orm');

  const unanalyzed = await db.select({ id: af.id })
    .from(af)
    .where(
      (await import('drizzle-orm')).and(
        (await import('drizzle-orm')).eq(af.accountId, accountId),
        drizzleIsNull(af.deletedAt),
        drizzleIsNull(af.lastAnalysisAt),
        (await import('drizzle-orm')).or(
          (await import('drizzle-orm')).eq(af.uploadStatus, 'COMPLETED'),
          drizzleIsNull(af.uploadStatus)
        )
      )
    )
    .limit(200);

  if (unanalyzed.length === 0) {
    console.info(`[retroactive] Account ${accountId}: no unanalyzed files`);
    return;
  }

  console.info(`[retroactive] Account ${accountId}: scheduling ${unanalyzed.length} files`);

  const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');

  for (const file of unanalyzed) {
    try {
      await analyzeFileSources([file.id], accountId, { origin: 'stripe-webhook/retroactive' });
    } catch (err) {
      console.error(`[retroactive] File ${file.id} failed:`, err);
    }
    // 2s throttle between calls to avoid rate limiting
    await new Promise(r => setTimeout(r, 2000));
  }

  console.info(`[retroactive] Account ${accountId}: done`);
}

// enforceStandardLimits is imported from @/lib/plan-enforcement

/**
 * invoice.payment_action_required — authentification 3D Secure requise.
 * Aucun droit n'est accorde ni retire : on journalise et on laisse Stripe
 * relancer le client. Le statut passera via invoice.paid ou payment_failed.
 */
async function handlePaymentActionRequired(invoice: Stripe.Invoice) {
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  console.warn('[stripe-webhook] action requise (3DS) pour le client', customerId, 'facture', invoice.id);

  await db
    .update(accountSubscriptions)
    .set({ status: 'past_due', updatedAt: new Date() })
    .where(eq(accountSubscriptions.stripeCustomerId, customerId ?? ''));

  // Action requise sur le paiement — obligatoire (cloche + email, CDC §7.6).
  try {
    if (customerId) {
      const [account] = await db.select({ id: accounts.id }).from(accounts)
        .where(eq(accounts.stripeCustomerId, customerId)).limit(1);
      if (account) {
        await emit({
          type: 'PAYMENT_ACTION_REQUIRED',
          accountId: account.id,
          entityType: 'invoice',
          entityId: invoice.id,
          payload: { accountId: account.id },
          dedupeKey: `account:payment-action-required:${invoice.id}`,
        });
      }
    }
  } catch (err) {
    console.error('[stripe-webhook] emit PAYMENT_ACTION_REQUIRED échoué:', err);
  }
}

/**
 * charge.refunded — remboursement.
 * On journalise pour l'administration ; la revocation eventuelle des droits
 * arrive via customer.subscription.updated/deleted si l'abonnement est annule.
 */
async function handleChargeRefunded(charge: Stripe.Charge) {
  const customerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
  console.warn(
    '[stripe-webhook] remboursement',
    charge.id,
    'client',
    customerId,
    'montant',
    charge.amount_refunded,
  );
}

/**
 * charge.dispute.created — litige (chargeback).
 * Le compte passe en past_due : les droits restent le temps de l'instruction,
 * mais l'etat est visible en administration.
 */
async function handleDisputeCreated(dispute: Stripe.Dispute) {
  const charge = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
  console.error('[stripe-webhook] LITIGE ouvert', dispute.id, 'sur la charge', charge, 'motif', dispute.reason);
}
