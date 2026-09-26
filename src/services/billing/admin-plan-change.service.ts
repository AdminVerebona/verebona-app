/**
 * Changement exceptionnel d'offre depuis le back-office — CDC Back-Office V1
 * §5.3.2 (ACC-A06 à ACC-A13), SUB-014, ERR-005.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * STRIPE D’ABORD, VEREBONA ENSUITE
 *
 * Le PATCH admin appelait `applyPlanChange` sans jamais toucher Stripe : les
 * droits changeaient dans Verebona, mais Stripe continuait de facturer
 * l'ancienne offre — et le webhook suivant pouvait rétablir l'ancienne offre.
 *
 * Désormais (ACC-A08) :
 *   1. l'abonnement Stripe est mis à jour vers le prix de la nouvelle offre,
 *      À PÉRIODICITÉ CONSTANTE (ACC-A10), SANS PRORATA NI FACTURE IMMÉDIATE
 *      (`proration_behavior: 'none'`, ACC-A09) et sans déplacer l'échéance
 *      (`billing_cycle_anchor: 'unchanged'`) : Stripe facturera le prix normal
 *      de la nouvelle offre à la prochaine échéance ;
 *   2. SEULEMENT SI Stripe a accepté, le changement est appliqué localement par
 *      le mécanisme existant `applyPlanChange` (ACC-A07, A11, A12, A13 :
 *      droits immédiats, enforcement au downgrade sans suppression, sortie Duo).
 *
 * Si Stripe refuse (ERR-005) : aucun changement local, erreur
 * `STRIPE_UPDATE_FAILED` (502). Le BO ne présente jamais le changement comme
 * finalisé.
 *
 * SANS ABONNEMENT STRIPE ACTIF (compte jamais abonné, essai sans carte,
 * abonnement Stripe terminé) : il n'y a aucune facturation future à aligner.
 * Le changement est appliqué localement seulement ; Stripe n'a rien à
 * recevoir, et le prochain abonnement sera créé au prix de l'offre choisie
 * par l'utilisateur au moment de souscrire.
 *
 * CHANGEMENT PROGRAMMÉ EN ATTENTE (baisse ou changement de périodicité
 * demandé par l'utilisateur, porté par un échéancier Stripe) : refus explicite
 * `SCHEDULED_CHANGE_PENDING`. L'échéancier écraserait le prix à la prochaine
 * échéance ; l'annuler d'office modifierait une décision de l'utilisateur.
 * À trancher par le produit (voir rapport).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { db } from '@/db';
import { accounts, accountSubscriptions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getStripeServer } from '@/lib/stripe';
import { resolvePriceId, type BillingPeriod, type PlanCode } from '@/lib/stripe-prices';
import { applyPlanChange, type KnownPlan } from '@/lib/plan-enforcement';

/** Offres qu'un admin peut attribuer : les offres commercialisées. */
export const ADMIN_ASSIGNABLE_PLANS = ['STANDARD', 'PREMIUM', 'PREMIUM_DUO'] as const;
export type AdminAssignablePlan = (typeof ADMIN_ASSIGNABLE_PLANS)[number];

export function isAdminAssignablePlan(value: unknown): value is AdminAssignablePlan {
  return typeof value === 'string' && (ADMIN_ASSIGNABLE_PLANS as readonly string[]).includes(value);
}

const PLAN_CODE_OF: Record<AdminAssignablePlan, PlanCode> = {
  STANDARD: 'standard',
  PREMIUM: 'premium',
  PREMIUM_DUO: 'premium_duo',
};

/** Statuts Stripe d'un abonnement qui ne facturera plus rien. */
const ENDED_STRIPE_STATUSES: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

export type AdminPlanChangeErrorCode =
  | 'ACCOUNT_NOT_FOUND'
  | 'SAME_PLAN'
  | 'SCHEDULED_CHANGE_PENDING'
  | 'BILLING_PERIOD_UNKNOWN'
  | 'STRIPE_UPDATE_FAILED'
  | 'LOCAL_APPLY_FAILED';

export type AdminPlanChangeResult =
  | {
      ok: true;
      oldPlan: string;
      newPlan: AdminAssignablePlan;
      /** `false` : aucun abonnement Stripe actif, changement purement local. */
      stripeUpdated: boolean;
      billingPeriod: BillingPeriod | null;
    }
  | { ok: false; code: AdminPlanChangeErrorCode; message: string; oldPlan?: string };

/** Statut HTTP associé à chaque refus. */
export const ADMIN_PLAN_CHANGE_HTTP_STATUS: Record<AdminPlanChangeErrorCode, number> = {
  ACCOUNT_NOT_FOUND: 404,
  SAME_PLAN: 409,
  SCHEDULED_CHANGE_PENDING: 409,
  BILLING_PERIOD_UNKNOWN: 409,
  STRIPE_UPDATE_FAILED: 502,
  LOCAL_APPLY_FAILED: 500,
};

/** Périodicité d'un prix Stripe récurrent. */
export function billingPeriodOfPrice(price: Pick<Stripe.Price, 'recurring'> | null | undefined): BillingPeriod | null {
  const interval = price?.recurring?.interval;
  if (interval === 'month') return 'monthly';
  if (interval === 'year') return 'yearly';
  return null;
}

/**
 * Paramètres de mise à jour de l'abonnement Stripe. Pure : c'est ici que se
 * concentrent ACC-A09 et ACC-A10, donc ici qu'on les vérifie.
 */
export function buildStripeUpdateParams(
  itemId: string,
  priceId: string,
  targetPlan?: PlanCode,
  now: Date = new Date(),
): Stripe.SubscriptionUpdateParams {
  return {
    items: [{ id: itemId, price: priceId, quantity: 1 }],
    // ACC-A09 : ni prorata, ni débit immédiat, ni remboursement, ni avoir.
    proration_behavior: 'none',
    // ACC-A10 : l'échéance ne bouge pas ; le prix normal s'applique à la
    // prochaine échéance, à la périodicité existante.
    billing_cycle_anchor: 'unchanged',
    // ══════════════════════════════════════════════════════════════════
    // MARQUEUR LU PAR LA SYNCHRONISATION (course admin / webhook)
    //
    // `subscriptions.update` déclenche `customer.subscription.updated`. Si
    // ce webhook est traité AVANT l'application locale, la synchronisation
    // voyait un changement d'offre « client » : notification et email à
    // l'utilisateur (contraire à ACC-A05, esprit ACC-A17) et historique
    // écrit une première fois, puis une seconde par l'application locale.
    //
    // Le marqueur (date + offre cible) permet à `syncSubscriptionFromStripe`
    // de reconnaître l'écho de CE changement : pas de notification, source
    // 'admin:override' (voir `isAdminPlanChangeEcho`).
    // ══════════════════════════════════════════════════════════════════
    metadata: {
      admin_plan_change: now.toISOString(),
      ...(targetPlan ? { admin_plan_change_to: targetPlan } : {}),
    },
  };
}

/**
 * L'offre cible est-elle déjà en place localement ? Pure.
 * Vrai quand le webhook de l'update Stripe a été synchronisé avant
 * l'application locale : l'historique est alors déjà écrit.
 */
export function planAlreadyApplied(currentPlanType: string | null | undefined, newPlan: AdminAssignablePlan): boolean {
  return currentPlanType === newPlan;
}

interface AccountSnapshot {
  id: number;
  ownerUserId: number;
  planType: string;
  subscriptionStatus: string;
  premiumUntil: number | null;
  stripeSubscriptionId: string | null;
  billingPeriod: string | null;
  scheduledPlanCode: string | null;
}

/** Dépendances injectables (tests). */
export interface AdminPlanChangeDeps {
  loadAccount(accountId: number): Promise<AccountSnapshot | null>;
  stripe(): Pick<Stripe, 'subscriptions'>;
  applyLocal(snapshot: AccountSnapshot, newPlan: AdminAssignablePlan): Promise<void>;
  resolvePrice(planCode: PlanCode, period: BillingPeriod): string;
}

async function loadAccountSnapshot(accountId: number): Promise<AccountSnapshot | null> {
  const [row] = await db
    .select({
      id: accounts.id,
      ownerUserId: accounts.ownerUserId,
      planType: accounts.planType,
      subscriptionStatus: accounts.subscriptionStatus,
      premiumUntil: accounts.premiumUntil,
      accountStripeSubscriptionId: accounts.stripeSubscriptionId,
      subStripeSubscriptionId: accountSubscriptions.stripeSubscriptionId,
      billingPeriod: accountSubscriptions.billingPeriod,
      scheduledPlanCode: accountSubscriptions.scheduledPlanCode,
    })
    .from(accounts)
    .leftJoin(accountSubscriptions, eq(accountSubscriptions.accountId, accounts.id))
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    planType: row.planType,
    subscriptionStatus: row.subscriptionStatus,
    premiumUntil: row.premiumUntil,
    // `account_subscriptions` est la source moderne ; `accounts` le repli
    // pour les comptes antérieurs à la tarification V2.
    stripeSubscriptionId: row.subStripeSubscriptionId ?? row.accountStripeSubscriptionId,
    billingPeriod: row.billingPeriod,
    scheduledPlanCode: row.scheduledPlanCode,
  };
}

/**
 * Application locale : mécanisme partagé avec le webhook (`applyPlanChange`),
 * plus l'offre portée par `account_subscriptions`, que lisent les droits.
 * Statut d’abonnement et échéance conservés : seule l’offre change.
 */
async function applyLocalPlanChange(snapshot: AccountSnapshot, newPlan: AdminAssignablePlan): Promise<void> {
  // ══════════════════════════════════════════════════════════════════════
  // IDEMPOTENT FACE AU WEBHOOK
  //
  // L'état est RELU : le webhook `customer.subscription.updated` de l'update
  // Stripe a pu être synchronisé entre-temps (offre, statut, échéance déjà à
  // jour, historique écrit avec la source 'admin:override'). Dans ce cas
  // aucune seconde ligne d'historique n'est écrite ; les effets idempotents
  // (Duo, limites Standard sans courriel) sont seulement confirmés, avec
  // l'offre de départ du snapshot pour que la sortie de Duo s'applique.
  // ══════════════════════════════════════════════════════════════════════
  const [current] = await db
    .select({
      planType: accounts.planType,
      subscriptionStatus: accounts.subscriptionStatus,
      premiumUntil: accounts.premiumUntil,
    })
    .from(accounts)
    .where(eq(accounts.id, snapshot.id))
    .limit(1);
  const alreadyApplied = planAlreadyApplied(current?.planType, newPlan);

  await applyPlanChange({
    accountId: snapshot.id,
    ownerUserId: snapshot.ownerUserId,
    oldPlanType: snapshot.planType,
    newPlanType: newPlan as KnownPlan,
    newSubStatus: current?.subscriptionStatus ?? snapshot.subscriptionStatus,
    newPremiumUntil: current ? current.premiumUntil : snapshot.premiumUntil,
    newMaxMembers: newPlan === 'PREMIUM_DUO' ? 2 : 1,
    source: 'admin:override',
    // ACC-A05 / A17 esprit : pas de courriel automatique sur action admin.
    sendEmails: false,
    recordHistory: !alreadyApplied,
  });
  await db
    .update(accountSubscriptions)
    .set({ planCode: PLAN_CODE_OF[newPlan], updatedAt: new Date() })
    .where(eq(accountSubscriptions.accountId, snapshot.id));
}

const defaultDeps: AdminPlanChangeDeps = {
  loadAccount: loadAccountSnapshot,
  stripe: getStripeServer,
  applyLocal: applyLocalPlanChange,
  resolvePrice: resolvePriceId,
};

/**
 * Change l'offre d'un compte à la demande d'un administrateur.
 * Ne lève pas : chaque issue est un résultat typé.
 */
export async function changePlanAsAdmin(
  input: { accountId: number; newPlan: AdminAssignablePlan },
  deps: AdminPlanChangeDeps = defaultDeps,
): Promise<AdminPlanChangeResult> {
  const snapshot = await deps.loadAccount(input.accountId);
  if (!snapshot) {
    return { ok: false, code: 'ACCOUNT_NOT_FOUND', message: 'Compte introuvable.' };
  }
  const oldPlan = snapshot.planType;
  if (oldPlan === input.newPlan) {
    return { ok: false, code: 'SAME_PLAN', message: 'Le compte dispose déjà de cette offre.', oldPlan };
  }

  // ── 1. Stripe ─────────────────────────────────────────────────────────
  let stripeUpdated = false;
  let billingPeriod: BillingPeriod | null =
    snapshot.billingPeriod === 'monthly' || snapshot.billingPeriod === 'yearly' ? snapshot.billingPeriod : null;

  if (snapshot.stripeSubscriptionId) {
    let subscription: Stripe.Subscription;
    try {
      subscription = await deps.stripe().subscriptions.retrieve(snapshot.stripeSubscriptionId);
    } catch (error) {
      return {
        ok: false,
        code: 'STRIPE_UPDATE_FAILED',
        message: `Stripe n'a pas pu être interrogé : ${(error as Error).message}. Aucun changement appliqué.`,
        oldPlan,
      };
    }

    if (!ENDED_STRIPE_STATUSES.has(subscription.status)) {
      if (subscription.schedule || snapshot.scheduledPlanCode) {
        return {
          ok: false,
          code: 'SCHEDULED_CHANGE_PENDING',
          message:
            "Un changement d'offre ou de périodicité programmé par l'utilisateur est en attente. " +
            "Il doit être annulé avant un changement exceptionnel. Aucun changement appliqué.",
          oldPlan,
        };
      }

      const item = subscription.items.data[0];
      // ACC-A10 : la périodicité est celle de l'abonnement Stripe en cours,
      // source de vérité de la facturation ; la base n'est qu'un repli.
      billingPeriod = billingPeriodOfPrice(item?.price) ?? billingPeriod;
      if (!item || !billingPeriod) {
        return {
          ok: false,
          code: 'BILLING_PERIOD_UNKNOWN',
          message: "Périodicité de l'abonnement Stripe indéterminable. Aucun changement appliqué.",
          oldPlan,
        };
      }

      try {
        const priceId = deps.resolvePrice(PLAN_CODE_OF[input.newPlan], billingPeriod);
        await deps.stripe().subscriptions.update(
          subscription.id,
          buildStripeUpdateParams(item.id, priceId, PLAN_CODE_OF[input.newPlan]),
        );
        stripeUpdated = true;
      } catch (error) {
        return {
          ok: false,
          code: 'STRIPE_UPDATE_FAILED',
          message: `Stripe a refusé la mise à jour de l'abonnement : ${(error as Error).message}. Aucun changement appliqué.`,
          oldPlan,
        };
      }
    }
  }

  // ── 2. Verebona ───────────────────────────────────────────────────────
  try {
    await deps.applyLocal(snapshot, input.newPlan);
  } catch (error) {
    return {
      ok: false,
      code: 'LOCAL_APPLY_FAILED',
      message: stripeUpdated
        ? `Stripe a été mis à jour mais l'application locale a échoué (${(error as Error).message}). ` +
          'La synchronisation Stripe rétablira la cohérence ; vérifiez la fiche dans quelques minutes.'
        : `Application locale impossible : ${(error as Error).message}.`,
      oldPlan,
    };
  }

  return { ok: true, oldPlan, newPlan: input.newPlan, stripeUpdated, billingPeriod };
}
