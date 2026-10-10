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
import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db';
import {
  accounts,
  accountMemberships,
  accountSubscriptions,
  duoAccounts,
  subscriptionHistory,
  users,
  withdrawalRequests,
} from '@/db/schema';
import { getStripeServer, type PlanTier } from '@/lib/stripe';
import { isPlanCode, type BillingPeriod } from '@/lib/stripe-prices';
import { periodOfInterval } from '@/lib/billing/plan-catalog';
import { PriceRecognitionError, primaryItem } from '@/services/billing/price-history.service';
import { invalidateAccountReadCache, invalidateUserReadCache } from '@/lib/server-cache';
import { markTrialConverted } from '@/services/trial.service';
import { sendDowngradeToStandardEmail, sendPremiumConfirmationEmail } from '@/lib/email/billing-emails';
import { endDuoSharing, enforceStandardLimits } from '@/lib/plan-enforcement';
import { unpaidDeadline } from '@/services/billing/unpaid-cycle.rules';

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

/** Price ID d'une ligne de facture (API basil : `pricing.price_details.price`). */
export function getInvoiceLinePriceId(line: Stripe.InvoiceLineItem | undefined | null): string | null {
  if (!line) return null;
  const fromPricing = line.pricing?.price_details?.price;
  if (fromPricing) return fromPricing;
  return idOf((line as unknown as { price?: string | { id: string } }).price);
}

/**
 * Price ID de la PREMIÈRE ligne d'une facture — conservé pour compatibilité
 * de lecture ; le registre des factures n'attribue plus une offre sur la
 * seule première ligne (CDC lookup_key LK-75, voir invoice-ledger.service).
 */
export function getInvoicePriceId(invoice: Stripe.Invoice): string | null {
  return getInvoiceLinePriceId(invoice.lines?.data?.[0]);
}

// ─── Correspondances d'état ───────────────────────────────────────────────────

/** Statuts de compte écrits ici — voir `lib/billing/subscription-status.ts`. */
type AccountStatus = 'ACTIVE' | 'CANCELED' | 'EXPIRED' | 'PAST_DUE' | 'WITHDRAWN';
type SubscriptionRowStatus = 'active' | 'past_due' | 'canceled' | 'readonly';

const PLAN_TYPE: Record<PlanTier, 'STANDARD' | 'PREMIUM' | 'PREMIUM_DUO'> = {
  standard: 'STANDARD',
  premium: 'PREMIUM',
  premium_duo: 'PREMIUM_DUO',
};

/**
 * États Stripe où l'offre payée est EN PLACE (offre, périodicité, dates
 * synchronisées). `past_due` en fait partie, mais n'ouvre AUCUN droit : la
 * ligne d'abonnement passe `past_due` (mode restreint immédiat, APP-FUNC-31).
 */
const PAID_STATUSES: Stripe.Subscription.Status[] = ['active', 'trialing', 'past_due'];
/** États Stripe qui mettent fin à l'offre. */
const TERMINAL_STATUSES: Stripe.Subscription.Status[] = ['canceled', 'unpaid', 'incomplete_expired'];

const toDate = (unix: number | null | undefined): Date | null =>
  typeof unix === 'number' && unix > 0 ? new Date(unix * 1000) : null;

// ══════════════════════════════════════════════════════════════════════════
// RECONNAISSANCE DU PRIX : REGISTRE HISTORIQUE, PLUS AUCUN REPLI PAR MONTANT
//
// L'offre était déduite des six variables STRIPE_PRICE_*, puis, à défaut,
// des métadonnées de l'abonnement SI le montant égalait le tarif du jour
// (`expectedAmountCents`). Après une hausse, tout abonné historique serait
// devenu « inconnu » ; et une égalité de montant n'a jamais prouvé une offre
// (EC-05). Désormais : item principal RECONNU par le registre historique
// (`primaryItem`, LK-65, LK-73). Inconnu ou ambigu → erreur typée levée
// (webhook rejoué, anomalie), sauf fin d'accès vérifiée (LK-67).
// ══════════════════════════════════════════════════════════════════════════

/** Fenêtre pendant laquelle un webhook est l'écho d'un changement admin. */
export const ADMIN_PLAN_CHANGE_ECHO_MS = 15 * 60 * 1000;

/**
 * L'événement est-il l'écho d'un changement exceptionnel d'offre fait depuis
 * le back-office (`admin-plan-change.service`) ? Pure.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * COURSE ADMIN / WEBHOOK (CDC BO ACC-A05, ACC-A07, ACC-A11)
 *
 * L'update Stripe admin déclenche `customer.subscription.updated`. Traité
 * avant l'application locale, il était synchronisé comme un changement
 * client : notification « offre modifiée » + courriels à l'utilisateur, et
 * historique écrit ici PUIS par l'application locale.
 *
 * Le marqueur `admin_plan_change` (date) + `admin_plan_change_to` (offre)
 * posé sur l'abonnement est reconnu ici : aucune notification, aucun
 * courriel, source 'admin:override'. Il reste sur l'abonnement Stripe après
 * coup : il n'est donc retenu que dans une fenêtre courte ET si l'offre
 * synchronisée est bien l'offre cible — un changement ultérieur du client
 * est traité normalement.
 * ══════════════════════════════════════════════════════════════════════════
 */
export function isAdminPlanChangeEcho(
  metadata: Record<string, string> | null | undefined,
  planTier: PlanTier,
  now: Date = new Date(),
): boolean {
  const at = Date.parse(metadata?.admin_plan_change ?? '');
  if (Number.isNaN(at)) return false;
  const age = now.getTime() - at;
  // Tolérance d'horloge : quelques minutes dans le futur.
  if (age > ADMIN_PLAN_CHANGE_ECHO_MS || age < -5 * 60 * 1000) return false;
  const target = metadata?.admin_plan_change_to;
  // Marqueur antérieur sans offre cible : on n'en déduit rien.
  return target === planTier;
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
  /** Prix contractuel de l'item principal (centimes), pour les courriels (LK-78). */
  unitAmountCents?: number | null;
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

/**
 * Lectures en cache du compte et de ses membres oubliées (cette instance) :
 * l'offre et le statut affichés suivent la synchronisation (APP-PERF-22).
 */
async function invalidateSessions(accountId: number): Promise<void> {
  invalidateAccountReadCache(accountId);
  const members = await db
    .select({ userId: accountMemberships.userId })
    .from(accountMemberships)
    .where(eq(accountMemberships.accountId, accountId));
  for (const m of members) {
    if (m.userId) invalidateUserReadCache(m.userId);
  }
}

export async function syncSubscriptionFromStripe(
  input: SubscriptionSyncInput,
): Promise<SubscriptionSyncResult | null> {
  const result = await synchroniserAbonnement(input);
  // CDC Assistant §25.7 : l'offre du compte a pu changer (webhook, retour de
  // paiement, synchronisation, changement d'offre par l'administration) —
  // les caches de l'assistant du compte sont invalidés.
  if (result && !result.skipped && result.accountId) {
    void import('@/services/verebona-assistant/events/business-events')
      .then(({ emitBusinessEvent }) => emitBusinessEvent({ type: 'PLAN_CHANGED', accountId: result.accountId }))
      .catch(() => { /* non bloquant */ });
  }
  return result;
}

async function synchroniserAbonnement(
  input: SubscriptionSyncInput,
): Promise<SubscriptionSyncResult | null> {
  const { subscription, source } = input;
  const customerId = idOf(subscription.customer);

  if (!customerId) {
    console.warn(`[subscription-sync] ${source} : abonnement ${subscription.id} sans client`);
    return null;
  }

  const metadataAccountId = Number(subscription.metadata?.accountId);
  const account = await findAccount(customerId, [input.accountIdHint, metadataAccountId]);
  if (!account) {
    console.error(`[subscription-sync] ${source} : aucun compte pour le client ${customerId}`);
    return null;
  }

  // ── Item principal reconnu (LK-65, LK-73) ──
  const primary = await primaryItem(subscription, `sync:${source}`);
  const terminalNow = TERMINAL_STATUSES.includes(subscription.status);
  let planTier: PlanTier;
  let item: Stripe.SubscriptionItem | undefined;
  let billingPeriodFromPrice: BillingPeriod | null = null;
  if ('error' in primary) {
    const detail = { subscriptionId: subscription.id, accountId: account.id, prices: subscription.items.data.map((i) => i.price?.id), reason: primary.error };
    if (primary.error === 'UNAVAILABLE') {
      throw new PriceRecognitionError('STRIPE_UNAVAILABLE', `Prix de ${subscription.id} non vérifiable (Stripe indisponible)`);
    }
    await reportUnknownPrice(account.id, subscription.id, detail);
    // LK-67 : un échec de rapprochement n'empêche JAMAIS une fin d'accès
    // vérifiée de l'abonnement courant ; il n'accorde ni ne détruit rien sinon.
    const localTier = (account.planType ?? '').toLowerCase();
    const paidNow = PAID_STATUSES.includes(subscription.status);
    const isCurrent = !account.stripeSubscriptionId || account.stripeSubscriptionId === subscription.id;
    // Seul un état qui OUVRIRAIT des droits exige le rapprochement : on lève
    // (rejeu). Paiement en attente ou ancien abonnement : rien n'est écrit.
    if (paidNow || (terminalNow && isCurrent && !isPlanCode(localTier))) {
      throw new PriceRecognitionError('UNKNOWN_HISTORICAL_PRICE', `Prix non rapproché pour ${subscription.id} (${primary.error})`);
    }
    planTier = isPlanCode(localTier) ? localTier : 'standard';
    item = subscription.items.data[0];
  } else {
    planTier = primary.result.planCode;
    item = primary.item;
    billingPeriodFromPrice = primary.result.billingPeriod;
  }
  const price = item?.price;

  const adminEcho = isAdminPlanChangeEcho(subscription.metadata, planTier);
  const effectiveSource = adminEcho ? 'admin:override' : source;
  const effectiveNotify = adminEcho ? false : (input.notify ?? true);

  const billingPeriod = billingPeriodFromPrice ?? periodOfInterval(price?.recurring?.interval, price?.recurring?.interval_count);
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
      stripePriceId: accountSubscriptions.stripePriceId,
      contractUnitAmountCents: accountSubscriptions.contractUnitAmountCents,
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
    // `past_due` : impayé, restreint dès maintenant — aucune grâce.
    newStatus =
      status === 'past_due'
        ? 'PAST_DUE'
        : subscription.cancel_at_period_end
          ? 'CANCELED' // résiliée, accès conservé jusqu'à la fin de période
          : 'ACTIVE';
  } else {
    newPlanType = 'STANDARD';
    rowStatus = 'canceled';
    newStatus = 'EXPIRED';
  }

  // ══════════════════════════════════════════════════════════════════════
  // RÉTRACTATION EXERCÉE SUR CET ABONNEMENT : AUCUN DROIT RENDU
  //
  // Les droits sont suspendus localement dès la confirmation, avant toute
  // action Stripe. Tant que l'annulation Stripe n'a pas abouti (Stripe
  // indisponible, reprise), un webhook de cet abonnement le voit encore
  // « actif » : sans ce garde-fou, il rétablirait l'écriture sur un compte
  // rétracté. Une NOUVELLE souscription (autre abonnement) n'est pas visée.
  // ══════════════════════════════════════════════════════════════════════
  const withdrawn = await isWithdrawnSubscription(account.id, subscription.id);
  if (withdrawn) {
    newStatus = 'WITHDRAWN';
    rowStatus = 'readonly';
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
        // Cycle d'impayé de 90 jours (GAP-06, voir unpaid-cycle.rules) :
        // refermé par un paiement confirmé ; ouvert ici si l'abonnement
        // arrive `past_due` avant le webhook `invoice.payment_failed`
        // (ordre non garanti). J0 n'est jamais déplacé.
        ...(isPaid && status !== 'past_due'
          ? { unpaidStartedAt: null, unpaidRecoveryEndsAt: null }
          : {}),
        ...(status === 'past_due' && !account.unpaidStartedAt
          ? { unpaidStartedAt: now, unpaidRecoveryEndsAt: unpaidDeadline(now) }
          : {}),
        ...(planTier === 'premium_duo' && isPaid ? { maxMembers: 2, duoAccountId } : {}),
        // Paiement appliqué : fin du suivi du paiement en attente (APP-PERF-18).
        ...(isPaid ? { checkoutSessionId: null, checkoutSessionCreatedAt: null, checkoutCheckAttempts: 0, checkoutNextCheckAt: null } : {}),
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
      // ── Prix contractuel (LK-19) : écrit depuis l'objet Stripe ──
      ...(item && price && !('error' in primary) ? contractColumns(item, price, existingRow, sameRowSubscription, now) : {}),
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
      // Impayé Duo : UNPAID_RECOVERY immédiatement (restreint, récupération
      // ouverte au membre) avec l'échéance du cycle du compte payeur.
      const cycleEndsAt = account.unpaidRecoveryEndsAt ?? unpaidDeadline(account.unpaidStartedAt ?? now);
      await tx
        .update(duoAccounts)
        .set({
          stripeSubscriptionId: subscription.id,
          stripeCustomerId: customerId,
          subscriptionStatus: isPaid ? (status === 'past_due' ? 'UNPAID_RECOVERY' : 'ACTIVE') : 'CANCELED',
          ...(isPaid && status !== 'past_due' ? { firstPaymentFailedAt: null, unpaidRecoveryEndsAt: null } : {}),
          ...(status === 'past_due' ? { unpaidRecoveryEndsAt: cycleEndsAt } : {}),
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

  // Tentative de souscription close (LK-44) et revalorisation constatée
  // (EX-022) — effets non bloquants, idempotents.
  if (isPaid) {
    void import('@/services/billing/price-operations.service')
      .then(async (m) => {
        await m.completeOpenCheckout(account.id);
        if (price?.id) await m.completeMutationsForPrice(account.id, price.id);
      })
      .catch(() => undefined);
  }
  void import('@/services/billing/price-revaluation.service')
    .then((m) => m.reconcileRevaluationFromSubscription(subscription))
    .catch(() => undefined);

  const result: SubscriptionSyncResult = { ...base, newPlanType, newStatus, activated, unitAmountCents: price?.unit_amount ?? null };
  await applyTransitionEffects(result, {
    source: effectiveSource,
    notify: effectiveNotify,
    silent: adminEcho,
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
  opts: {
    source: string;
    notify: boolean;
    /** Écho d'un changement admin : ni notification ni courriel (ACC-A05). */
    silent?: boolean;
    premiumUntil: number | null;
    oldPremiumUntil: number | null;
  },
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

  const becomesPremium = PREMIUM_PLANS.includes(newPlanType) && !PREMIUM_PLANS.includes(oldPlanType);
  // Un seul email par souscription : quand l'email de confirmation part, la
  // notification « Offre activée / modifiée » reste dans la cloche (et en
  // push) mais n'envoie pas son propre email « Votre abonnement Verebona ».
  const confirmationEmail = becomesPremium && opts.notify && !!opts.premiumUntil;

  if (!opts.silent) {
    await notifierChangementDeStatut(result, { confirmationEmailSent: confirmationEmail });
  }

  if (becomesPremium) {
    if (confirmationEmail && opts.premiumUntil) {
      sendPremiumConfirmationEmail(ownerUserId, new Date(opts.premiumUntil * 1000), {
        planLabel: LIBELLE_OFFRE[newPlanType] ?? newPlanType,
        unitAmountCents: result.unitAmountCents ?? null,
        billingPeriod: result.billingPeriod,
      }).catch(console.error);
    }
    // V4 — Analyse rétroactive via service dédié (batch de 5, throttle 2s)
    import('@/services/document-ai/retroactive-analysis.service')
      .then(({ scheduleRetroactiveAnalysis }) => scheduleRetroactiveAnalysis(accountId))
      .catch((err: Error) => console.error('[subscription-sync] analyse rétroactive :', err.message));
  }

  // Sortie de Premium Duo vers Premium : plus de second utilisateur
  // (AID-DUO-005). Vers Standard, `enforceStandardLimits` s'en charge.
  if (oldPlanType === 'PREMIUM_DUO' && newPlanType === 'PREMIUM') {
    await endDuoSharing(ownerUserId).catch((e: Error) =>
      console.error('[subscription-sync] fin du partage Duo non appliquée :', e.message),
    );
  }

  const leavesPremium = newPlanType === 'STANDARD' && PREMIUM_PLANS.includes(oldPlanType);
  if (leavesPremium) {
    // Un passage à Standard payé n'est pas une perte d'abonnement.
    if (opts.notify && !result.isPaid) {
      sendDowngradeToStandardEmail(ownerUserId).catch(console.error);
    }
    // Courriels de retrait des membres : pas sur un changement admin.
    await enforceStandardLimits(accountId, ownerUserId, !opts.silent).catch((e: Error) =>
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
const STATUTS_AVEC_OFFRE = ['ACTIVE', 'PAST_DUE', 'CANCELED'];

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
async function notifierChangementDeStatut(
  result: SubscriptionSyncResult,
  opts: { confirmationEmailSent: boolean } = { confirmationEmailSent: false },
): Promise<void> {
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
          confirmationEmailSent: opts.confirmationEmailSent,
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
        billingPeriod: result.billingPeriod,
        previousPlanCode: oldPlanType,
        previousPlanLabel: LIBELLE_OFFRE[oldPlanType] ?? oldPlanType,
        direction: apres > avant ? 'upgrade' : apres < avant ? 'downgrade' : 'lateral',
        confirmationEmailSent: opts.confirmationEmailSent,
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

/**
 * Synchronisation depuis un événement `customer.subscription.*`.
 *
 * L'objet porté par l'événement est un INSTANTANÉ : Stripe ne garantit ni
 * l'ordre ni l'unicité des livraisons. Un `updated` ancien (« active »)
 * reçu après un `updated` plus récent (« past_due ») rouvrait les droits
 * d'un compte en impayé (APP-FUNC-31, CA-17). L'état COURANT est relu chez
 * Stripe ; si la relecture échoue, l'erreur remonte et Stripe relivre
 * l'événement plus tard — jamais de synchronisation sur un instantané.
 */
export async function syncSubscriptionFromEvent(
  eventSubscription: Pick<Stripe.Subscription, 'id'>,
  options: Omit<SubscriptionSyncInput, 'subscription'>,
  retrieve: (id: string) => Promise<Stripe.Subscription> = (id) => getStripeServer().subscriptions.retrieve(id),
): Promise<SubscriptionSyncResult | null> {
  const current = await retrieve(eventSubscription.id);
  return syncSubscriptionFromStripe({ ...options, subscription: current });
}

export type CheckoutSyncOutcome =
  | { status: 'synced'; result: SubscriptionSyncResult }
  | { status: 'ignored'; reason: 'NOT_OWNED' | 'NOT_COMPLETE' | 'EXPIRED' | 'NO_SUBSCRIPTION' | 'NOT_SYNCED' };

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
  // Session expirée : le paiement n'aura jamais lieu (Stripe : 24 h max).
  if (session.status === 'expired') return { status: 'ignored', reason: 'EXPIRED' };
  if (session.status !== 'complete') return { status: 'ignored', reason: 'NOT_COMPLETE' };

  const subscription = session.subscription;
  if (!subscription) return { status: 'ignored', reason: 'NO_SUBSCRIPTION' };

  const result =
    typeof subscription === 'string'
      ? await syncSubscriptionById(subscription, { source: 'checkout-return', accountIdHint: compteSession })
      : await syncSubscriptionFromStripe({ subscription, source: 'checkout-return', accountIdHint: compteSession });

  return result ? { status: 'synced', result } : { status: 'ignored', reason: 'NOT_SYNCED' };
}

// Filet « paiement effectué mais non appliqué » : voir
// `pending-checkout.service.ts` (réconciliation durable, APP-PERF-18). Il
// n'est plus exécuté pendant la lecture des droits.

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

/**
 * Colonnes du prix contractuel. Le changement de prix (revalorisation,
 * changement d'offre) date `contract_price_since` et conserve le montant
 * précédent : le MRR suit la date RÉELLE du changement (LK-77).
 */
function contractColumns(
  item: Stripe.SubscriptionItem,
  price: Stripe.Price,
  existing: { stripePriceId: string | null; contractUnitAmountCents: number | null } | undefined,
  sameSubscription: boolean,
  now: Date,
) {
  const changed = sameSubscription && existing?.stripePriceId && existing.stripePriceId !== price.id;
  return {
    stripeSubscriptionItemId: item.id,
    stripePriceId: price.id,
    stripeProductId: idOf(price.product as string | { id: string } | null),
    contractUnitAmountCents: price.unit_amount ?? null,
    contractCurrency: (price.currency ?? 'eur').toLowerCase(),
    contractQuantity: item.quantity ?? 1,
    contractInterval: price.recurring?.interval ?? null,
    contractTaxBehavior: price.tax_behavior ?? 'unspecified',
    contractVerifiedAt: now,
    ...(changed
      ? { contractPriceSince: toDate(item.current_period_start) ?? now, previousUnitAmountCents: existing?.contractUnitAmountCents ?? null }
      : !sameSubscription ? { contractPriceSince: null, previousUnitAmountCents: null } : {}),
  };
}

async function reportUnknownPrice(accountId: number, subscriptionId: string, detail: Record<string, unknown>): Promise<void> {
  console.error(JSON.stringify({ evt: 'billing.sync.unknown_price', code: 'UNKNOWN_HISTORICAL_PRICE', ...detail }));
  try {
    const { reportAnomaly } = await import('@/services/admin/anomaly.service');
    await reportAnomaly({
      domain: 'stripe',
      fingerprint: `stripe:unknown-price:${subscriptionId}`,
      title: 'Abonnement à un prix non rapproché (UNKNOWN_HISTORICAL_PRICE)',
      accountId,
      detail,
    });
  } catch { /* la levée de l'erreur suffit à faire rejouer */ }
}

/** Une rétractation (non rejetée) a-t-elle été exercée sur cet abonnement ? */
async function isWithdrawnSubscription(accountId: number, stripeSubscriptionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: withdrawalRequests.id })
    .from(withdrawalRequests)
    .where(and(
      eq(withdrawalRequests.accountId, accountId),
      eq(withdrawalRequests.stripeSubscriptionId, stripeSubscriptionId),
      ne(withdrawalRequests.status, 'rejected'),
    ))
    .limit(1)
    .catch(() => []);
  return rows.length > 0;
}
