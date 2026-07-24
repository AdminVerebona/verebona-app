import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
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
import { eq, and, sql, isNull } from 'drizzle-orm';
import {
  sendPremiumConfirmationEmail,
  sendDowngradeToStandardEmail,
  sendTrialConfirmationEmail,
} from '@/lib/email/billing-emails';
import { getTierFromPriceId, STRIPE_PRODUCTS } from '@/lib/stripe';
import { resolvePlanFromPriceId } from '@/lib/stripe-prices';
import { applyScheduledChange } from '@/services/plan-change.service';
import { trackFunnelEvent } from '@/services/funnel-analytics.service';
import { enforceStandardLimits } from '@/lib/plan-enforcement';
import { grantReferralRewardForFirstBilling, mapLegacyPlanTypeToCommercialCode } from '@/services/commercial-model.service';

// ─── Init ──────────────────────────────────────────────────────────────────────

const getStripe = () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
  return new Stripe(key, { apiVersion: '2025-08-27.basil' });
};

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

    try {
      event = stripe.webhooks.constructEvent(
        body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!
      );
    } catch (err) {
      console.error('[Stripe Webhook] Signature verification failed:', err);
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
  const customerId = session.customer as string;
  const subscriptionId = session.subscription as string;
  const duoId = session.metadata?.duoId ? parseInt(session.metadata.duoId) : null;

  if (!customerId || !subscriptionId) {
    console.warn('[Webhook] checkout.session.completed: missing customer or subscription');
    return;
  }

  if (duoId) {
    // ── DUO checkout ──
    await db
      .update(duoAccounts)
      .set({ stripeSubscriptionId: subscriptionId, updatedAt: new Date() })
      .where(eq(duoAccounts.id, duoId));

    // Synchronise le compte lié
    await activateDuoOnAccount(duoId);
    return;
  }

  // ── Premium checkout ──
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.stripeCustomerId, customerId))
    .limit(1);

  if (!account) {
    console.error(`[Webhook] checkout.session.completed: no account for customer ${customerId}`);
    return;
  }

  await db
    .update(accounts)
    .set({ stripeSubscriptionId: subscriptionId, updatedAt: new Date() })
    .where(eq(accounts.id, account.id));

}

// ─── customer.subscription.created / updated ──────────────────────────────────

async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription,
  eventType: string
) {
  const customerId = subscription.customer as string;
  const subscriptionId = subscription.id;
  const status = subscription.status; // Stripe status
  // In Stripe API 2025-08-27.basil, current_period_end is on the item, not the subscription
  const currentPeriodEnd = ((subscription.items.data[0] as any).current_period_end ?? (subscription as any).current_period_end) as number; // Unix seconds
  const cancelAtPeriodEnd = subscription.cancel_at_period_end;
  const priceId = subscription.items.data[0]?.price.id;
  // Offre + periodicite deduites du Price ID reel (CDC : ne jamais se fier
  // aux seules metadonnees pour accorder des droits).
  const resolvedBilling = resolvePlanFromPriceId(priceId);
  const tier = getTierFromPriceId(priceId);

  if (!tier) {
    console.warn(`[Webhook] subscription.updated: unknown price ${priceId}`);
    return;
  }

  // ── DUO sub ──
  const [duoAccount] = await db
    .select()
    .from(duoAccounts)
    .where(eq(duoAccounts.stripeSubscriptionId, subscriptionId))
    .limit(1);

  if (duoAccount) {
    let duoStatus: 'ACTIVE' | 'PAST_DUE_GRACE' | 'UNPAID_RECOVERY' | 'CANCELED' = 'ACTIVE';

    if (['active', 'trialing'].includes(status)) {
      duoStatus = cancelAtPeriodEnd ? 'ACTIVE' : 'ACTIVE'; // still active until period ends
    } else if (status === 'past_due') {
      duoStatus = duoAccount.subscriptionStatus === 'UNPAID_RECOVERY' ? 'UNPAID_RECOVERY' : 'PAST_DUE_GRACE';
    } else if (['unpaid', 'canceled', 'incomplete_expired'].includes(status)) {
      duoStatus = 'CANCELED';
    }

    await db
      .update(duoAccounts)
      .set({ subscriptionStatus: duoStatus, updatedAt: new Date() })
      .where(eq(duoAccounts.id, duoAccount.id));

    // Si DUO revient ACTIVE (ex: paiement en retard résolu), synchronise le compte
    if (duoStatus === 'ACTIVE') {
      await activateDuoOnAccount(duoAccount.id);
    }

    return;
  }

  // ── Premium sub ──
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.stripeCustomerId, customerId))
    .limit(1);

  if (!account) {
    console.error(`[Webhook] subscription.updated: no account for customer ${customerId}`);
    return;
  }

  const oldPlanType = account.planType;
  let newPlanType = 'STANDARD';
  let newSubStatus = 'NONE';
  let newMaxMembers: number | undefined;

  // Déterminer si la souscription porte un price PREMIUM_DUO
  const isDuoPrice = priceId === STRIPE_PRODUCTS.PREMIUM_DUO.priceId;
  const isStandardPrice = priceId === STRIPE_PRODUCTS.STANDARD.priceId;

  if (['active', 'trialing'].includes(status)) {
    if (isDuoPrice) {
      newPlanType = 'PREMIUM_DUO';
      newMaxMembers = 2;
    } else if (isStandardPrice) {
      newPlanType = 'STANDARD';
    } else {
      newPlanType = 'PREMIUM';
    }
    newSubStatus = cancelAtPeriodEnd ? 'CANCELED' : (status === 'trialing' ? 'TRIALING' : 'ACTIVE');
  } else if (status === 'past_due') {
    newPlanType = isDuoPrice ? 'PREMIUM_DUO' : isStandardPrice ? 'STANDARD' : 'PREMIUM';
    newSubStatus = account.subscriptionStatus === 'PAST_DUE_GRACE' ? 'PAST_DUE_GRACE' : 'ACTIVE';
  } else if (['unpaid', 'canceled', 'incomplete_expired'].includes(status)) {
    newPlanType = 'STANDARD';
    newSubStatus = 'EXPIRED';
  }

  const subscriptionTier = newPlanType === 'PREMIUM_DUO' ? 'pro' : (newPlanType === 'PREMIUM' || newPlanType === 'STANDARD') ? 'premium' : 'free';
  const isPaidPlan = newPlanType === 'PREMIUM' || newPlanType === 'PREMIUM_DUO' || newPlanType === 'STANDARD';

  // Dates de trial réelles depuis Stripe (trial_start / trial_end sur la subscription)
  const trialStartUnix = (subscription as any).trial_start as number | null | undefined;
  const trialEndUnix = (subscription as any).trial_end as number | null | undefined;
  const trialEndsAtDate = trialEndUnix ? new Date(trialEndUnix * 1000) : (status === 'trialing' ? new Date(currentPeriodEnd * 1000) : null);

  await db
    .update(accounts)
    .set({
      planType: newPlanType,
      subscriptionTier,
      subscriptionStatus: newSubStatus,
      stripeSubscriptionId: subscriptionId,
      premiumUntil: isPaidPlan ? currentPeriodEnd : null,
      trialEndsAt: status === 'trialing' ? trialEndsAtDate : null,
      ...(newMaxMembers !== undefined ? { maxMembers: newMaxMembers } : {}),
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, account.id));

  // Atomic update to ensure only one trial confirmation email is sent
  if (status === 'trialing') {
    const [updated] = await db
      .update(accounts)
      .set({ trialConfirmationEmailSentAt: new Date() })
      .where(
        and(
          eq(accounts.id, account.id),
          isNull(accounts.trialConfirmationEmailSentAt)
        )
      )
      .returning({ id: accounts.id });

    if (updated) {
    if (trialEndsAtDate) {
      await sendTrialConfirmationEmail(account.ownerUserId, trialEndsAtDate).catch(console.error);
    }
    }
  }

  await db.insert(accountSubscriptions).values({
    accountId: account.id,
    planCode: mapLegacyPlanTypeToCommercialCode(newPlanType),
    status: status,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    currentPeriodEndAt: isPaidPlan ? new Date(currentPeriodEnd * 1000) : null,
    // Periodicite deduite du Price ID reel (jamais des metadonnees seules)
    ...(resolvedBilling ? { billingPeriod: resolvedBilling.period } : {}),
    ...(trialStartUnix ? { trialStartedAt: new Date(trialStartUnix * 1000) } : {}),
    ...(trialEndUnix ? { trialEndsAt: new Date(trialEndUnix * 1000) } : {}),
    updatedAt: new Date(),
    createdAt: new Date(),
  }).onConflictDoUpdate({
    target: accountSubscriptions.accountId,
    set: {
      planCode: mapLegacyPlanTypeToCommercialCode(newPlanType),
      status: status,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      currentPeriodEndAt: isPaidPlan ? new Date(currentPeriodEnd * 1000) : null,
      ...(trialStartUnix ? { trialStartedAt: new Date(trialStartUnix * 1000) } : {}),
      ...(trialEndUnix ? { trialEndsAt: new Date(trialEndUnix * 1000) } : {}),
      updatedAt: new Date(),
    },
  });

  await db.insert(subscriptionHistory).values({
    userId: account.ownerUserId,
    accountId: account.id,
    oldTier: oldPlanType,
    newTier: newPlanType,
    oldPremiumUntil: account.premiumUntil,
    newPremiumUntil: isPaidPlan ? currentPeriodEnd : null,
    source: `webhook:${eventType}`,
    createdAt: new Date(),
  });

  // Always sync users.planType so the session badge matches the account plan
  if (newPlanType !== oldPlanType) {
    await db
      .update(users)
      .set({ planType: newPlanType, updatedAt: new Date() })
      .where(eq(users.id, account.ownerUserId));
  }

  // For PREMIUM→PREMIUM_DUO upgrade via subscription item change: link the duoAccount subscription
  if (newPlanType === 'PREMIUM_DUO' && oldPlanType !== 'PREMIUM_DUO') {
    const duoIdFromMeta = subscription.metadata?.duoId ? parseInt(subscription.metadata.duoId) : null;
    if (duoIdFromMeta) {
      await db
        .update(duoAccounts)
        .set({ stripeSubscriptionId: subscriptionId, subscriptionStatus: 'ACTIVE', updatedAt: new Date() })
        .where(eq(duoAccounts.id, duoIdFromMeta));
    } else if (account.duoAccountId) {
      await db
        .update(duoAccounts)
        .set({ stripeSubscriptionId: subscriptionId, subscriptionStatus: 'ACTIVE', updatedAt: new Date() })
        .where(eq(duoAccounts.id, account.duoAccountId));
    }
  }

  // Email activation Premium
  if (newPlanType === 'PREMIUM' && oldPlanType !== 'PREMIUM' && oldPlanType !== 'PREMIUM_DUO') {
    sendPremiumConfirmationEmail(account.ownerUserId, new Date(currentPeriodEnd * 1000)).catch(console.error);

    // V4 — Analyse rétroactive via service dédié (batch de 5, throttle 2s)
    import('@/services/document-ai/retroactive-analysis.service').then(({ scheduleRetroactiveAnalysis }) => {
      scheduleRetroactiveAnalysis(account.id).catch((err: Error) =>
        console.error('[webhook] retroactive analysis error:', err)
      );
    });
  }

  // Downgrade actions
  if (newPlanType === 'STANDARD' && (oldPlanType === 'PREMIUM' || oldPlanType === 'PREMIUM_DUO')) {
    sendDowngradeToStandardEmail(account.ownerUserId).catch(console.error);
    await enforceStandardLimits(account.id, account.ownerUserId);
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
  const customerId = invoice.customer as string;
  const subscriptionId = (invoice as any).subscription as string | null;

  if (!subscriptionId) return; // one-time payment, not a sub

  // ── DUO renewal ──
  const [duoAccount] = await db
    .select()
    .from(duoAccounts)
    .where(eq(duoAccounts.stripeSubscriptionId, subscriptionId))
    .limit(1);

  if (duoAccount) {
    // Clear grace state if it was in dunning
    await db
      .update(duoAccounts)
      .set({
        subscriptionStatus: 'ACTIVE',
        firstPaymentFailedAt: null,
        graceDeadlineAt: null,
        updatedAt: new Date(),
      })
      .where(eq(duoAccounts.id, duoAccount.id));

    // Ensure account is marked DUO
    await activateDuoOnAccount(duoAccount.id);
    return;
  }

  // ── Premium / DUO (personal sub) renewal ──
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.stripeCustomerId, customerId))
    .limit(1);

  if (!account) return;

  // Get the current period end from Stripe invoice line items
  const periodEnd = (invoice as any).lines?.data?.[0]?.period?.end as number | undefined;
  const newPremiumUntil = periodEnd ?? account.premiumUntil; // Unix seconds

  // Detect if the invoice line corresponds to a PREMIUM_DUO price (upgrade proration invoice)
  const invoicePriceId = (invoice as any).lines?.data?.[0]?.price?.id as string | undefined;
  const isNowDuo = invoicePriceId === STRIPE_PRODUCTS.PREMIUM_DUO.priceId;
  const isNowStandard = invoicePriceId === STRIPE_PRODUCTS.STANDARD.priceId;

  const resolvedPlanType = isNowDuo ? 'PREMIUM_DUO' : isNowStandard ? 'STANDARD' : 'PREMIUM';
  const resolvedTier = isNowDuo ? 'pro' : 'premium';

  await db
    .update(accounts)
    .set({
      planType: resolvedPlanType,
      subscriptionTier: resolvedTier,
      subscriptionStatus: 'ACTIVE',
      premiumUntil: newPremiumUntil,
      ...(isNowDuo ? { maxMembers: 2 } : {}),
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, account.id));

  await db.insert(accountSubscriptions).values({
    accountId: account.id,
    planCode: mapLegacyPlanTypeToCommercialCode(resolvedPlanType),
    status: 'active',
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    currentPeriodEndAt: newPremiumUntil ? new Date(newPremiumUntil * 1000) : null,
    firstBilledAt: new Date(),
    updatedAt: new Date(),
    createdAt: new Date(),
  }).onConflictDoUpdate({
    target: accountSubscriptions.accountId,
    set: {
      planCode: mapLegacyPlanTypeToCommercialCode(resolvedPlanType),
      status: 'active',
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      currentPeriodEndAt: newPremiumUntil ? new Date(newPremiumUntil * 1000) : null,
      firstBilledAt: sql`COALESCE(${accountSubscriptions.firstBilledAt}, now())`,
      updatedAt: new Date(),
    },
  });

  await grantReferralRewardForFirstBilling(account.id, invoice.id).catch((err: Error) => {
    console.error('[Webhook] referral reward grant failed:', err.message);
  });

  // CDC §17 : paiement abouti, et denouement de l'essai.
  void (async () => {
    const [subRow] = await db
      .select({
        planCode: accountSubscriptions.planCode,
        billingPeriod: accountSubscriptions.billingPeriod,
        trialEndsAt: accountSubscriptions.trialEndsAt,
      })
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountId, account.id))
      .limit(1);

    await trackFunnelEvent({
      event: 'payment_succeeded',
      accountId: account.id,
      planCode: subRow?.planCode ?? null,
      billingPeriod: subRow?.billingPeriod ?? null,
    });

    const expired = subRow?.trialEndsAt ? subRow.trialEndsAt.getTime() < Date.now() : false;
    await trackFunnelEvent({
      event: expired ? 'converted_after_expiry' : 'converted_before_expiry',
      accountId: account.id,
      planCode: subRow?.planCode ?? null,
      billingPeriod: subRow?.billingPeriod ?? null,
    });
  })().catch((err: Error) => console.error('[Webhook] suivi analytique:', err.message));

  // CDC §10 : un changement d'offre ou de periodicite programme prend effet
  // au renouvellement, sans prorata.
  await applyScheduledChange(account.id).then((r) => {
    if (r.applied) {
      console.info('[Webhook] changement programme applique:', r.planCode, r.billingPeriod);
    }
  }).catch((err: Error) => {
    console.error('[Webhook] application du changement programme echouee:', err.message);
  });

  // Always sync users.planType so badge matches account plan
  if (account.planType !== resolvedPlanType) {
    await db
      .update(users)
      .set({ planType: resolvedPlanType, updatedAt: new Date() })
      .where(eq(users.id, account.ownerUserId));
  }
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
  const subscriptionId = (invoice as any).subscription as string | null;

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

    // TODO: send dunning email to account owner
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

  const { runUnifiedAnalysisPipeline } = await import('@/services/document-ai/unified-analysis-pipeline');

  for (const file of unanalyzed) {
    try {
      await runUnifiedAnalysisPipeline([file.id], accountId);
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
