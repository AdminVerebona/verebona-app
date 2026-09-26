/**
 * Suppression d'un compte déclenchée depuis le back-office — CDC Back-Office
 * V1 §5.3.3 (ACC-A14 à ACC-A17), REC-ACC-06.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE WORKFLOW UNIQUE, ORIGINE « admin »
 *
 * Le DELETE admin enchaînait une cascade SQL ad hoc (titulaire, fournisseurs,
 * transmissions…) : ni purge du stockage, ni conservation des preuves
 * (acceptations CGSU, rétractations), ni contrôle d'orphelins, ni trace.
 *
 * ACC-A14 impose « le même workflow unique que la suppression initiée par
 * l'utilisateur/RGPD ; seule l'origine diffère ». La suppression admin :
 *   1. ouvre un compte à rebours `scheduled_account_deletions` de délai NUL,
 *      motif ADMIN, origine admin ;
 *   2. l'exécute immédiatement par `executeScheduledDeletion` — même périmètre
 *      (titulaire + second utilisateur Duo), même purge S3, mêmes preuves
 *      conservées, même contrôle d'orphelins, même trace EXECUTED/FAILED.
 *
 * Irréversible (ACC-A16) : aucune annulation n'est exposée au BO. En cas
 * d'échec technique, la trace FAILED porte le motif et rien n'est supprimé
 * (transaction) ; l'admin peut relancer.
 *
 * Aucune notification n'est envoyée (ACC-A17) : les rappels J-7 / J-1 ne
 * concernent que les comptes à rebours encore SCHEDULED.
 *
 * Compte à rebours utilisateur déjà en cours (rétractation, demande
 * volontaire) : il est clos (CANCELLED, « SUPERSEDED_BY_ADMIN_DELETION ») et
 * remplacé par celui de l'admin — l'index unique n'admet qu'un compte à
 * rebours actif par compte, et l'origine tracée doit être celle de l'acte
 * réellement exécuté.
 *
 * ABONNEMENT STRIPE ACTIF : refus `STRIPE_SUBSCRIPTION_ACTIVE`. Le BO ne
 * résilie jamais un abonnement (§7.4) ; supprimer le compte en laissant
 * l'abonnement actif continuerait de facturer un client sans compte. La
 * résiliation se fait dans Stripe (lien fourni), puis la suppression.
 *
 * TOUS LES ABONNEMENTS CONNUS DU COMPTE sont contrôlés, pas seulement
 * `account_subscriptions` (tarification V2) : un compte antérieur ne porte
 * son abonnement que sur `accounts.stripe_subscription_id`, un Duo sur
 * `duo_accounts.stripe_subscription_id`. Le statut est relu chez Stripe
 * (source de vérité de la facturation) ; Stripe injoignable → repli sur le
 * statut local, et dans le doute on refuse (un refus se lève en résiliant
 * dans Stripe ; une facturation sans compte ne se rattrape pas).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { db } from '@/db';
import { accounts, accountSubscriptions, duoAccounts } from '@/db/schema';
import { eq, or } from 'drizzle-orm';
import { getStripeServer } from '@/lib/stripe';
import {
  cancelDeletion,
  executeScheduledDeletion,
  getActiveSchedule,
  scheduleDeletion,
  type ExecutionResult,
} from '@/services/account/scheduled-deletion.service';

/** Statuts d'abonnement Stripe qui facturent encore (ou vont facturer). */
const BILLING_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'trialing',
  'past_due',
  'unpaid',
]);

export type AdminDeletionOutcome =
  | { ok: true; scheduleId: number; execution: ExecutionResult; supersededScheduleId: number | null }
  | { ok: false; code: 'ACCOUNT_NOT_FOUND' }
  | { ok: false; code: 'STRIPE_SUBSCRIPTION_ACTIVE'; stripeSubscriptionId: string }
  | { ok: false; code: 'EXECUTION_FAILED'; scheduleId: number; execution: ExecutionResult };

/**
 * Un abonnement Stripe facture-t-il encore ? Pure. Un abonnement dont la
 * résiliation est programmée en fin de période facture encore jusque-là mais
 * ne renouvellera pas : il n'empêche pas la suppression.
 */
export function hasBillingStripeSubscription(sub: {
  stripeSubscriptionId: string | null;
  status: string | null;
  cancelAtPeriodEnd: boolean | null;
} | null | undefined): boolean {
  if (!sub?.stripeSubscriptionId) return false;
  if (sub.cancelAtPeriodEnd) return false;
  return BILLING_SUBSCRIPTION_STATUSES.has((sub.status ?? '').toLowerCase());
}

/** Statuts locaux (colonnes `accounts` / `duo_accounts`) d'un abonnement qui facture. */
const LOCAL_BILLING_STATUSES: ReadonlySet<string> = new Set([
  'ACTIVE', 'TRIALING', 'PAST_DUE', 'PAST_DUE_GRACE', 'UNPAID_RECOVERY',
  'active', 'trialing', 'past_due', 'unpaid',
]);

export interface SubscriptionCandidate {
  stripeSubscriptionId: string;
  /** Statut local connu (repli si Stripe est injoignable). */
  localStatus: string | null;
  localCancelAtPeriodEnd: boolean | null;
}

/**
 * Abonnements Stripe connus d'un compte, dédoublonnés : V2
 * (`account_subscriptions`), historique (`accounts`), Duo (`duo_accounts`
 * rattaché au compte ou dont le titulaire est le propriétaire du compte).
 */
export async function listAccountSubscriptionCandidates(accountId: number): Promise<SubscriptionCandidate[]> {
  const [account] = await db
    .select({
      ownerUserId: accounts.ownerUserId,
      duoAccountId: accounts.duoAccountId,
      stripeSubscriptionId: accounts.stripeSubscriptionId,
      subscriptionStatus: accounts.subscriptionStatus,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) return [];

  const out = new Map<string, SubscriptionCandidate>();
  const add = (id: string | null | undefined, localStatus: string | null, cancel: boolean | null) => {
    if (id && !out.has(id)) out.set(id, { stripeSubscriptionId: id, localStatus, localCancelAtPeriodEnd: cancel });
  };

  const [sub] = await db
    .select({
      stripeSubscriptionId: accountSubscriptions.stripeSubscriptionId,
      status: accountSubscriptions.status,
      cancelAtPeriodEnd: accountSubscriptions.cancelAtPeriodEnd,
    })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, accountId))
    .limit(1);
  add(sub?.stripeSubscriptionId, sub?.status ?? null, sub?.cancelAtPeriodEnd ?? null);
  add(account.stripeSubscriptionId, account.subscriptionStatus, null);

  const duos = await db
    .select({ stripeSubscriptionId: duoAccounts.stripeSubscriptionId, status: duoAccounts.subscriptionStatus })
    .from(duoAccounts)
    .where(account.duoAccountId
      ? or(eq(duoAccounts.id, account.duoAccountId), eq(duoAccounts.billingOwnerUserId, account.ownerUserId))
      : eq(duoAccounts.billingOwnerUserId, account.ownerUserId));
  for (const d of duos) add(d.stripeSubscriptionId, d.status, null);

  return [...out.values()];
}

/**
 * Premier abonnement qui facture encore, statut relu chez Stripe.
 * Abonnement inconnu de Stripe (supprimé, autre mode) : ne facture pas.
 * Stripe injoignable : statut local.
 */
export async function findBillingSubscription(
  candidates: SubscriptionCandidate[],
  stripe: Pick<Stripe, 'subscriptions'>,
): Promise<string | null> {
  for (const c of candidates) {
    let billing: boolean;
    try {
      const s = await stripe.subscriptions.retrieve(c.stripeSubscriptionId);
      billing = hasBillingStripeSubscription({
        stripeSubscriptionId: s.id,
        status: s.status,
        cancelAtPeriodEnd: s.cancel_at_period_end,
      });
    } catch (e) {
      const code = (e as { code?: string; statusCode?: number });
      if (code.code === 'resource_missing' || code.statusCode === 404) continue;
      billing = !c.localCancelAtPeriodEnd && LOCAL_BILLING_STATUSES.has(c.localStatus ?? '');
    }
    if (billing) return c.stripeSubscriptionId;
  }
  return null;
}

export async function deleteAccountAsAdmin(
  accountId: number,
  now: Date = new Date(),
  stripe: () => Pick<Stripe, 'subscriptions'> = getStripeServer,
): Promise<AdminDeletionOutcome> {
  const [account] = await db
    .select({ id: accounts.id, ownerUserId: accounts.ownerUserId })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) return { ok: false, code: 'ACCOUNT_NOT_FOUND' };

  const candidates = await listAccountSubscriptionCandidates(accountId);
  if (candidates.length > 0) {
    let client: Pick<Stripe, 'subscriptions'> | null = null;
    try {
      client = stripe();
    } catch {
      client = null; // Stripe non configuré : repli sur les statuts locaux.
    }
    const offline: Pick<Stripe, 'subscriptions'> = {
      subscriptions: { retrieve: async () => { throw new Error('STRIPE_UNAVAILABLE'); } },
    } as unknown as Pick<Stripe, 'subscriptions'>;
    const billing = await findBillingSubscription(candidates, client ?? offline);
    if (billing) {
      return { ok: false, code: 'STRIPE_SUBSCRIPTION_ACTIVE', stripeSubscriptionId: billing };
    }
  }

  let supersededScheduleId: number | null = null;
  const existing = await getActiveSchedule(accountId);
  if (existing && existing.origin !== 'admin') {
    await cancelDeletion(accountId, 'SUPERSEDED_BY_ADMIN_DELETION');
    supersededScheduleId = existing.id;
  }

  const schedule = await scheduleDeletion({
    accountId,
    userId: account.ownerUserId,
    reason: 'ADMIN',
    origin: 'admin',
    confirmedAt: now,
    delayDays: 0,
  });

  const execution = await executeScheduledDeletion(schedule.id, { now });
  if (execution.status !== 'executed') {
    return { ok: false, code: 'EXECUTION_FAILED', scheduleId: schedule.id, execution };
  }
  return { ok: true, scheduleId: schedule.id, execution, supersededScheduleId };
}
