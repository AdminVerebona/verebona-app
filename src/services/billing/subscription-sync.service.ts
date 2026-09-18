/**
 * Synchronisation d'un abonnement Stripe vers le compte Verebona.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE ÉCRITURE DE L'ÉTAT D'ABONNEMENT
 *
 * L'état payé était écrit à quatre endroits (webhook `subscription.updated`,
 * webhook `invoice.payment_succeeded`, retour de paiement `/api/billing/me`,
 * resynchronisation admin), chacun avec ses propres règles — et ses propres
 * trous :
 *
 *   - les offres étaient comparées aux anciens Price IDs : un Premium payé
 *     arrivait en STANDARD ;
 *   - la périodicité n'était écrite qu'à la création de la ligne ;
 *   - `invoice.subscription` n'existe plus dans l'API 2025-08-27.basil : le
 *     paiement n'était jamais constaté, `first_billed_at` restait vide et le
 *     bandeau d'essai ne disparaissait jamais ;
 *   - ni date de souscription, ni date de renouvellement, ni
 *     `contract_concluded_at` (dont dépend le droit de rétractation).
 *
 * Tous ces chemins appellent désormais `syncSubscriptionFromStripe`, qui
 * écrit l'état complet à partir de l'objet Stripe. Elle est idempotente :
 * la rejouer ne change rien.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import {
  accounts,
  accountMemberships,
  accountSubscriptions,
  duoAccounts,
  subscriptionHistory,
  users,
} from '@/db/schema';
import { getStripeServer, getTierFromPriceId, type PlanTier } from '@/lib/stripe';
import {
  expectedAmountCents,
  isBillingPeriod,
  isPlanCode,
  resolvePlanFromPriceId,
  type BillingPeriod,
} from '@/lib/stripe-prices';
import { serverCacheDelete, serverCacheGet, serverCacheSet } from '@/lib/server-cache';
import { markTrialConverted } from '@/services/trial.service';
import { sendDowngradeToStandardEmail, sendPremiumConfirmationEmail } from '@/lib/email/billing-emails';
import { enforceStandardLimits } from '@/lib/plan-enforcement';

// ─── Lecture des objets Stripe (API 2025-08-27.basil) ─────────────────────────

const idOf = (value: string | { id: string } | null | undefined): string | null =>
  !value ? null : typeof value === 'string' ? value : value.id;

/** Abonnement d'une facture : `invoice.subscription` a disparu en basil. */
export function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const fromParent = idOf(invoice.parent?.subscription_details?.subscription);
  if (fromParent) return fromParent;
  // Filet pour les événements émis avec une version d'API antérieure.
  return idOf((invoice as unknown as { subscription?: string | { id: string } }).subscription);
}

/** Price ID de la première ligne d'une facture. */
export function getInvoicePriceId(invoice: Stripe.Invoice): string | null {
  const line = invoice.lines?.data?.[0];
  if (!line) return null;
  const fromPricing = line.pricing?.price_details?.price;
  if (fromPricing) return fromPricing;
  return idOf((line as unknown as { price?: string | { id: string } }).price);
}

// ─── Correspondances d'état ───────────────────────────────────────────────────

type AccountStatus = 'ACTIVE' | 'CANCELED' | 'EXPIRED' | 'PAST_DUE_GRACE';
type SubscriptionRowStatus = 'active' | 'past_due' | 'canceled';

const PLAN_TYPE: Record<PlanTier, 'STANDARD' | 'PREMIUM' | 'PREMIUM_DUO'> = {
  standard: 'STANDARD',
  premium: 'PREMIUM',
  premium_duo: 'PREMIUM_DUO',
};

/** États Stripe qui donnent accès à l'offre payée. */
const PAID_STATUSES: Stripe.Subscription.Status[] = ['active', 'trialing', 'past_due'];
/** États Stripe qui mettent fin à l'offre. */
const TERMINAL_STATUSES: Stripe.Subscription.Status[] = ['canceled', 'unpaid', 'incomplete_expired'];

const toDate = (unix: number | null | undefined): Date | null =>
  typeof unix === 'number' && unix > 0 ? new Date(unix * 1000) : null;

function billingPeriodOf(price: Stripe.Price | undefined): BillingPeriod | null {
  // Catalogue, puis intervalle Stripe : la périodicité est toujours connue
  // d'un prix récurrent.
  if (!price) return null;
  const fromCatalog = resolvePlanFromPriceId(price.id);
  if (fromCatalog) return fromCatalog.period;
  if (price.recurring?.interval === 'month') return 'monthly';
  if (price.recurring?.interval === 'year') return 'yearly';
  return null;
}

// ─── Synchronisation ──────────────────────────────────────────────────────────

/**
 * Offre lue dans les métadonnées, MAIS seulement si le montant du prix
 * correspond au tarif de cette offre et de cette périodicité.
 *
 * Le Price ID reste la source de vérité. Ce repli couvre le cas où la
 * variable d'environnement du prix diffère entre le processus qui a créé la
 * session et celui qui la synchronise (déploiement en cours, variable
 * renommée) : le paiement était encaissé et le compte restait en essai.
 * Des métadonnées seules ne suffisent jamais : le montant payé doit concorder.
 */
function tierFromVerifiedMetadata(
  subscription: Stripe.Subscription,
  price: Stripe.Price | undefined,
): PlanTier | null {
  const tier = subscription.metadata?.planTier;
  const period = subscription.metadata?.billing_period;
  if (!price || !isPlanCode(tier) || !isBillingPeriod(period)) return null;
  const interval = period === 'monthly' ? 'month' : 'year';
  if (price.recurring?.interval !== interval) return null;
  if (price.unit_amount !== expectedAmountCents(tier, period)) return null;
  console.warn(
    `[subscription-sync] prix ${price.id} absent du catalogue : offre ${tier}/${period} ` +
    'retenue d\'après les métadonnées, montant vérifié. Contrôler les variables STRIPE_PRICE_*.',
  );
  return tier;
}

export interface SubscriptionSyncInput {
  subscription: Stripe.Subscription;
  /** Origine de l'appel, pour les logs (`webhook:…`, `checkout-return`, `admin`). */
  source: string;
  /** Compte présumé (métadonnées de session déjà vérifiées par l'appelant). */
  accountIdHint?: number | null;
  /** Date d'encaissement connue (facture payée). */
  paidAt?: Date | null;
  /** Emails client lors d'un changement d'offre (faux pour l'admin). */
  notify?: boolean;
}

export interface SubscriptionSyncResult {
  accountId: number;
  ownerUserId: number;
  subscriptionId: string;
  stripeStatus: Stripe.Subscription.Status;
  planTier: PlanTier;
  billingPeriod: BillingPeriod | null;
  oldPlanType: string;
  newPlanType: string;
  oldStatus: string;
  newStatus: string;
  /** L'abonnement donne accès à l'offre payée. */
  isPaid: boolean;
  /** Première activation de CET abonnement sur le compte. */
  activated: boolean;
  /** Aucune écriture : état intermédiaire ou abonnement périmé. */
  skipped?: 'INCOMPLETE' | 'STALE_SUBSCRIPTION';
}

type AccountRow = typeof accounts.$inferSelect;

async function findAccount(
  customerId: string,
  candidates: Array<number | null | undefined>,
): Promise<AccountRow | null> {
  for (const candidate of candidates) {
    if (!candidate || Number.isNaN(candidate)) continue;
    const [row] = await db.select().from(accounts).where(eq(accounts.id, candidate)).limit(1);
    if (!row) continue;
    // Une métadonnée ne suffit pas : le client Stripe doit concorder.
    if (row.stripeCustomerId === customerId || row.stripeCustomerId === null) return row;
    console.warn(
      `[subscription-sync] compte ${candidate} ignoré : client ${row.stripeCustomerId} ≠ ${customerId}`,
    );
  }
  const [byCustomer] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.stripeCustomerId, customerId))
    .limit(1);
  return byCustomer ?? null;
}

async function invalidateSessions(accountId: number): Promise<void> {
  const members = await db
    .select({ userId: accountMemberships.userId })
    .from(accountMemberships)
    .where(eq(accountMemberships.accountId, accountId));
  for (const m of members) {
    if (m.userId) serverCacheDelete(`users:me:${m.userId}`);
  }
}

export async function syncSubscriptionFromStripe(
  input: SubscriptionSyncInput,
): Promise<SubscriptionSyncResult | null> {
  const { subscription, source } = input;
  const customerId = idOf(subscription.customer);
  const item = subscription.items.data[0];
  const price = item?.price;
  const planTier = getTierFromPriceId(price?.id) ?? tierFromVerifiedMetadata(subscription, price);

  if (!customerId) {
    console.warn(`[subscription-sync] ${source} : abonnement ${subscription.id} sans client`);
    return null;
  }
  if (!planTier) {
    console.warn(`[subscription-sync] ${source} : prix inconnu ${price?.id} (abonnement ${subscription.id})`);
    return null;
  }

  const metadataAccountId = Number(subscription.metadata?.accountId);
  const account = await findAccount(customerId, [input.accountIdHint, metadataAccountId]);
  if (!account) {
    console.error(`[subscription-sync] ${source} : aucun compte pour le client ${customerId}`);
    return null;
  }

  const billingPeriod = billingPeriodOf(price);
  const status = subscription.status;
  const isPaid = PAID_STATUSES.includes(status);
  const isTerminal = TERMINAL_STATUSES.includes(status);
  const isCurrentSubscription =
    !account.stripeSubscriptionId || account.stripeSubscriptionId === subscription.id;

  const base = {
    accountId: account.id,
    ownerUserId: account.ownerUserId,
    subscriptionId: subscription.id,
    stripeStatus: status,
    planTier,
    billingPeriod,
    oldPlanType: account.planType,
    newPlanType: account.planType,
    oldStatus: account.subscriptionStatus,
    newStatus: account.subscriptionStatus,
    isPaid,
    activated: false,
  };

  // Paiement en attente (3DS…) : aucun droit tant que Stripe n'a pas encaissé.
  if (!isPaid && !isTerminal) {
    return { ...base, isPaid: false, skipped: 'INCOMPLETE' };
  }
  // Fin d'un ANCIEN abonnement alors qu'un autre est en place : ne rien casser.
  if (isTerminal && !isCurrentSubscription) {
    return { ...base, isPaid: false, skipped: 'STALE_SUBSCRIPTION' };
  }

  const now = new Date();
  const periodStart = toDate(item?.current_period_start);
  const periodEnd = toDate(item?.current_period_end);
  const startedAt = toDate(subscription.start_date) ?? now;
  const isNewSubscription = account.stripeSubscriptionId !== subscription.id;
  const activated = isPaid && (isNewSubscription || account.subscriptionStatus !== 'ACTIVE');

  const [existingRow] = await db
    .select({
      stripeSubscriptionId: accountSubscriptions.stripeSubscriptionId,
      firstBilledAt: accountSubscriptions.firstBilledAt,
      contractConcludedAt: accountSubscriptions.contractConcludedAt,
    })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, account.id))
    .limit(1);

  let newPlanType: string;
  let newStatus: AccountStatus;
  let rowStatus: SubscriptionRowStatus;

  if (isPaid) {
    newPlanType = PLAN_TYPE[planTier];
    rowStatus = status === 'past_due' ? 'past_due' : 'active';
    newStatus =
      status === 'past_due'
        ? 'PAST_DUE_GRACE'
        : subscription.cancel_at_period_end
          ? 'CANCELED' // résiliée, accès conservé jusqu'à la fin de période
          : 'ACTIVE';
  } else {
    newPlanType = 'STANDARD';
    rowStatus = 'canceled';
    newStatus = 'EXPIRED';
  }

  const duoIdFromMetadata = Number(subscription.metadata?.duoId) || null;
  const duoAccountId = planTier === 'premium_duo' ? (duoIdFromMetadata ?? account.duoAccountId) : account.duoAccountId;

  // ── Date de conclusion du contrat : fixée une fois par abonnement ──
  // Point de départ du délai de rétractation (CDC 6 §3.1). Prise sur la date
  // de démarrage Stripe, pas sur l'heure de la synchronisation, pour qu'une
  // synchronisation tardive ne rende pas le premier paiement « antérieur au
  // contrat ».
  const sameRowSubscription = existingRow?.stripeSubscriptionId === subscription.id;
  const contractConcludedAt = isPaid
    ? (sameRowSubscription && existingRow?.contractConcludedAt) || startedAt
    : existingRow?.contractConcludedAt ?? null;
  const firstBilledAt = existingRow?.firstBilledAt ?? (isPaid ? (input.paidAt ?? now) : null);

  await db.transaction(async (tx) => {
    await tx
      .update(accounts)
      .set({
        planType: newPlanType,
        subscriptionTier: newPlanType === 'PREMIUM_DUO' ? 'pro' : isPaid ? 'premium' : 'free',
        subscriptionStatus: newStatus,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
        premiumUntil: isPaid && periodEnd ? Math.floor(periodEnd.getTime() / 1000) : null,
        planRenewalDate: isPaid ? periodEnd : null,
        subscriptionStartedAt: isNewSubscription || !account.subscriptionStartedAt
          ? startedAt
          : account.subscriptionStartedAt,
        // L'essai Verebona est terminé dès qu'une offre payée est en place.
        trialEndsAt: isPaid ? null : account.trialEndsAt,
        ...(isPaid && status !== 'past_due'
          ? { pastDueGraceStartedAt: null, pastDueGraceEndsAt: null }
          : {}),
        ...(planTier === 'premium_duo' && isPaid ? { maxMembers: 2, duoAccountId } : {}),
        ...(isPaid ? { checkoutSessionId: null, checkoutSessionCreatedAt: null } : {}),
        updatedAt: now,
      })
      .where(eq(accounts.id, account.id));

    const rowValues = {
      planCode: planTier,
      status: rowStatus,
      billingPeriod,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
      currentPeriodStartAt: periodStart,
      currentPeriodEndAt: periodEnd,
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      firstBilledAt,
      contractConcludedAt,
      updatedAt: now,
    };
    await tx
      .insert(accountSubscriptions)
      .values({ accountId: account.id, ...rowValues, createdAt: now })
      .onConflictDoUpdate({ target: accountSubscriptions.accountId, set: rowValues });

    await tx
      .update(users)
      .set({ planType: newPlanType, updatedAt: now })
      .where(eq(users.id, account.ownerUserId));

    if (planTier === 'premium_duo' && duoAccountId) {
      await tx
        .update(duoAccounts)
        .set({
          stripeSubscriptionId: subscription.id,
          stripeCustomerId: customerId,
          subscriptionStatus: isPaid ? (status === 'past_due' ? 'PAST_DUE_GRACE' : 'ACTIVE') : 'CANCELED',
          ...(isPaid && status !== 'past_due' ? { firstPaymentFailedAt: null, graceDeadlineAt: null } : {}),
          updatedAt: now,
        })
        .where(eq(duoAccounts.id, duoAccountId));
    }
  });

  if (activated) {
    const [owner] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, account.ownerUserId))
      .limit(1);
    if (owner?.email) {
      await markTrialConverted({ accountId: account.id, email: owner.email }).catch((e: Error) =>
        console.error('[subscription-sync] conversion d\'essai non tracée :', e.message),
      );
    }
  }

  await invalidateSessions(account.id).catch(() => undefined);

  const result: SubscriptionSyncResult = { ...base, newPlanType, newStatus, activated };
  await applyTransitionEffects(result, {
    source,
    notify: input.notify ?? true,
    premiumUntil: isPaid && periodEnd ? Math.floor(periodEnd.getTime() / 1000) : null,
    oldPremiumUntil: account.premiumUntil,
  });

  console.info(
    `[subscription-sync] ${source} : compte ${account.id} ${account.planType}/${account.subscriptionStatus} → ` +
    `${newPlanType}/${newStatus} (${subscription.id}, ${billingPeriod ?? 'périodicité ?'})`,
  );

  return result;
}

const PREMIUM_PLANS = ['PREMIUM', 'PREMIUM_DUO'];

/**
 * Effets d'un changement d'offre : historique, emails, analyse rétroactive,
 * application des limites Standard.
 *
 * Exécutés ici, par le premier chemin qui constate la transition (webhook
 * de checkout, webhook d'abonnement, retour de paiement). Les chemins
 * suivants trouvent un état déjà à jour et ne les rejouent pas — laissés
 * dans le seul `customer.subscription.updated`, ils étaient sautés dès que
 * le retour de paiement arrivait le premier.
 */
async function applyTransitionEffects(
  result: SubscriptionSyncResult,
  opts: { source: string; notify: boolean; premiumUntil: number | null; oldPremiumUntil: number | null },
): Promise<void> {
  const { accountId, ownerUserId, oldPlanType, newPlanType } = result;
  if (oldPlanType === newPlanType && !result.activated) return;

  try {
    await db.insert(subscriptionHistory).values({
      userId: ownerUserId,
      accountId,
      oldTier: oldPlanType,
      newTier: newPlanType,
      oldPremiumUntil: opts.oldPremiumUntil,
      newPremiumUntil: opts.premiumUntil,
      source: opts.source,
      createdAt: new Date(),
    });
  } catch (e) {
    console.error('[subscription-sync] historique non enregistré :', (e as Error).message);
  }

  await notifierChangementDeStatut(result);

  const becomesPremium = PREMIUM_PLANS.includes(newPlanType) && !PREMIUM_PLANS.includes(oldPlanType);
  if (becomesPremium) {
    if (opts.notify && opts.premiumUntil) {
      sendPremiumConfirmationEmail(ownerUserId, new Date(opts.premiumUntil * 1000)).catch(console.error);
    }
    // V4 — Analyse rétroactive via service dédié (batch de 5, throttle 2s)
    import('@/services/document-ai/retroactive-analysis.service')
      .then(({ scheduleRetroactiveAnalysis }) => scheduleRetroactiveAnalysis(accountId))
      .catch((err: Error) => console.error('[subscription-sync] analyse rétroactive :', err.message));
  }

  const leavesPremium = newPlanType === 'STANDARD' && PREMIUM_PLANS.includes(oldPlanType);
  if (leavesPremium) {
    // Un passage à Standard payé n'est pas une perte d'abonnement.
    if (opts.notify && !result.isPaid) {
      sendDowngradeToStandardEmail(ownerUserId).catch(console.error);
    }
    await enforceStandardLimits(accountId, ownerUserId).catch((e: Error) =>
      console.error('[subscription-sync] limites Standard non appliquées :', e.message),
    );
  }
}

/** Libellé d'offre affiché au client. */
const LIBELLE_OFFRE: Record<string, string> = {
  STANDARD: 'Standard',
  PREMIUM: 'Premium',
  PREMIUM_DUO: 'Premium Duo',
  PREMIUM_PRO: 'Premium Pro',
};

/** Rang des offres, pour distinguer une montée d'une baisse de gamme. */
const RANG_OFFRE: Record<string, number> = {
  STANDARD: 1,
  PREMIUM: 2,
  PREMIUM_DUO: 3,
  PREMIUM_PRO: 4,
};

/** Statuts de compte qui signifient « une offre payante était en place ». */
const STATUTS_AVEC_OFFRE = ['ACTIVE', 'PAST_DUE_GRACE', 'CANCELED'];

/**
 * Prévient le client que le statut de son compte a changé.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX MOMENTS DISTINCTS, DEUX MESSAGES
 *
 *   · activation — le compte n'avait aucune offre (essai terminé, compte
 *     restreint, réabonnement) : « Votre compte a été activé avec une offre
 *     Standard. » ;
 *   · changement — le compte était déjà abonné et change d'offre :
 *     « Votre compte a été upgradé vers une offre Premium. »
 *
 * Émis ici, et nulle part ailleurs : c'est le seul endroit qui connaisse à
 * la fois l'état précédent et le nouvel état, quel que soit le chemin
 * emprunté (webhook, retour de paiement, resynchronisation admin).
 *
 * La fin d'une offre a déjà ses propres notifications (résiliation,
 * suspension, compte en lecture seule) : elle n'est pas traitée ici.
 *
 * Une notification ne doit jamais faire échouer une synchronisation
 * d'abonnement : toute erreur est journalisée et ignorée.
 * ══════════════════════════════════════════════════════════════════════════
 */
async function notifierChangementDeStatut(result: SubscriptionSyncResult): Promise<void> {
  if (!result.isPaid) return;

  const { accountId, oldPlanType, newPlanType, oldStatus, subscriptionId } = result;
  const avaitUneOffre = STATUTS_AVEC_OFFRE.includes((oldStatus ?? '').toUpperCase());
  const libelle = LIBELLE_OFFRE[newPlanType] ?? newPlanType;

  try {
    const { emit } = await import('@/lib/notifications');

    if (!avaitUneOffre) {
      await emit({
        type: 'SUBSCRIPTION_ACTIVATED',
        payload: {
          planCode: newPlanType,
          planLabel: libelle,
          billingPeriod: result.billingPeriod,
        },
        accountId,
        entityType: 'subscription',
        entityId: subscriptionId,
        // Une seule notification par abonnement et par offre activée, même
        // si plusieurs chemins synchronisent le même paiement.
        dedupeKey: `subscription:${subscriptionId}:activated:${newPlanType}`,
      });
      return;
    }

    if (oldPlanType === newPlanType) return;

    const avant = RANG_OFFRE[oldPlanType] ?? 0;
    const apres = RANG_OFFRE[newPlanType] ?? 0;
    await emit({
      type: 'SUBSCRIPTION_CHANGED',
      payload: {
        planCode: newPlanType,
        planLabel: libelle,
        previousPlanCode: oldPlanType,
        previousPlanLabel: LIBELLE_OFFRE[oldPlanType] ?? oldPlanType,
        direction: apres > avant ? 'upgrade' : apres < avant ? 'downgrade' : 'lateral',
      },
      accountId,
      entityType: 'subscription',
      entityId: subscriptionId,
      dedupeKey: `subscription:${subscriptionId}:changed:${oldPlanType}:${newPlanType}`,
    });
  } catch (e) {
    console.error('[subscription-sync] notification de changement de statut :', (e as Error).message);
  }
}

/** Relit l'abonnement chez Stripe puis le synchronise. */
export async function syncSubscriptionById(
  subscriptionId: string,
  options: Omit<SubscriptionSyncInput, 'subscription'>,
): Promise<SubscriptionSyncResult | null> {
  const subscription = await getStripeServer().subscriptions.retrieve(subscriptionId);
  return syncSubscriptionFromStripe({ ...options, subscription });
}

export type CheckoutSyncOutcome =
  | { status: 'synced'; result: SubscriptionSyncResult }
  | { status: 'ignored'; reason: 'NOT_OWNED' | 'NOT_COMPLETE' | 'NO_SUBSCRIPTION' | 'NOT_SYNCED' };

/**
 * Retour de Stripe Checkout : synchronise sans attendre le webhook.
 * La session doit appartenir au compte appelant.
 */
export async function syncFromCheckoutSession(params: {
  sessionId: string;
  accountId: number;
  /** Utilisateur appelant : une session qu'il a lui-même ouverte lui appartient. */
  userId?: number;
  /** Tous les comptes de l'utilisateur (le compte « courant » peut différer). */
  accountIds?: number[];
}): Promise<CheckoutSyncOutcome> {
  const session = await getStripeServer().checkout.sessions.retrieve(params.sessionId, {
    expand: ['subscription'],
  });

  // ══════════════════════════════════════════════════════════════════
  // PROPRIÉTÉ DE LA SESSION
  //
  // La comparaison portait sur UN compte, lu par `LIMIT 1` sans ordre sur
  // les appartenances de l'utilisateur. Avec plusieurs appartenances
  // (invitation, Duo), le compte relu au retour pouvait différer de celui
  // de la session : NOT_OWNED, et le paiement n'était jamais appliqué.
  //
  // La session est acceptée si elle vise l'un des comptes de l'utilisateur,
  // ou si c'est lui qui l'a ouverte. La synchronisation s'applique au
  // compte de la session, pas au compte relu.
  // ══════════════════════════════════════════════════════════════════
  const compteSession = Number(session.metadata?.accountId) || null;
  const comptesAutorises = new Set([params.accountId, ...(params.accountIds ?? [])]);
  const ouverteParLui = params.userId != null && session.metadata?.userId === String(params.userId);
  const possede = compteSession != null && (comptesAutorises.has(compteSession) || ouverteParLui);

  if (!possede) {
    console.warn(
      `[subscription-sync] session ${params.sessionId} refusée pour le compte ${params.accountId}`,
    );
    return { status: 'ignored', reason: 'NOT_OWNED' };
  }
  if (session.status !== 'complete') return { status: 'ignored', reason: 'NOT_COMPLETE' };

  const subscription = session.subscription;
  if (!subscription) return { status: 'ignored', reason: 'NO_SUBSCRIPTION' };

  const result =
    typeof subscription === 'string'
      ? await syncSubscriptionById(subscription, { source: 'checkout-return', accountIdHint: compteSession })
      : await syncSubscriptionFromStripe({ subscription, source: 'checkout-return', accountIdHint: compteSession });

  return result ? { status: 'synced', result } : { status: 'ignored', reason: 'NOT_SYNCED' };
}

/** Délai pendant lequel une session Checkout ouverte peut encore aboutir. */
const CHECKOUT_PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Au plus une interrogation de Stripe par compte sur cette durée. */
const CHECKOUT_PENDING_THROTTLE_MS = 20_000;

/**
 * Filet de sécurité : applique un paiement dont le retour n'a pas été traité.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PAYÉ CHEZ STRIPE, TOUJOURS EN ESSAI DANS VEREBONA
 *
 * L'état payé n'était écrit que par deux chemins : le webhook et la page de
 * retour. Si le webhook n'est pas configuré sur l'environnement (ou échoue)
 * ET que la page de retour n'est pas atteinte (adresse de retour erronée,
 * onglet fermé, application mobile), le compte restait en essai
 * indéfiniment alors que le client avait payé.
 *
 * La création de session mémorise son identifiant sur le compte
 * (`checkout_session_id`). Tant qu'il est présent et récent, la lecture des
 * droits vérifie ici — au plus toutes les 20 s — si la session a abouti, et
 * synchronise le compte le cas échéant. La synchronisation efface
 * l'identifiant : la vérification cesse d'elle-même.
 *
 * Ne lève jamais : la lecture des droits ne doit pas échouer pour autant.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function syncPendingCheckoutForAccount(accountId: number): Promise<boolean> {
  const cle = `checkout-pending:${accountId}`;
  if (serverCacheGet<boolean>(cle)) return false;
  serverCacheSet(cle, true, CHECKOUT_PENDING_THROTTLE_MS);

  try {
    const [account] = await db
      .select({
        checkoutSessionId: accounts.checkoutSessionId,
        checkoutSessionCreatedAt: accounts.checkoutSessionCreatedAt,
        ownerUserId: accounts.ownerUserId,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    if (!account?.checkoutSessionId || !account.checkoutSessionCreatedAt) return false;
    const age = Date.now() - new Date(account.checkoutSessionCreatedAt).getTime();
    if (age > CHECKOUT_PENDING_MAX_AGE_MS) return false;

    const outcome = await syncFromCheckoutSession({
      sessionId: account.checkoutSessionId,
      accountId,
      userId: account.ownerUserId,
    });
    if (outcome.status === 'synced') {
      console.info(`[subscription-sync] paiement en attente appliqué au compte ${accountId}`);
      return true;
    }
    return false;
  } catch (e) {
    console.error(`[subscription-sync] vérification du paiement en attente (compte ${accountId}) :`, (e as Error).message);
    return false;
  }
}

/**
 * Resynchronisation manuelle d'un compte (admin) : retient l'abonnement en
 * cours du client, à défaut le plus récent.
 */
export async function syncAccountFromStripeCustomer(params: {
  accountId: number;
  customerId: string;
}): Promise<{ result: SubscriptionSyncResult | null; subscriptionCount: number }> {
  const list = await getStripeServer().subscriptions.list({
    customer: params.customerId,
    status: 'all',
    limit: 20,
  });
  const ordered = [...list.data].sort((a, b) => b.created - a.created);
  const chosen = ordered.find((s) => PAID_STATUSES.includes(s.status)) ?? ordered[0];
  if (!chosen) return { result: null, subscriptionCount: 0 };

  const result = await syncSubscriptionFromStripe({
    subscription: chosen,
    source: 'admin-resync',
    accountIdHint: params.accountId,
    notify: false,
  });
  return { result, subscriptionCount: list.data.length };
}
