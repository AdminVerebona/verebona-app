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
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { accounts, accountSubscriptions } from '@/db/schema';
import { eq } from 'drizzle-orm';
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

export async function deleteAccountAsAdmin(accountId: number, now: Date = new Date()): Promise<AdminDeletionOutcome> {
  const [account] = await db
    .select({ id: accounts.id, ownerUserId: accounts.ownerUserId })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) return { ok: false, code: 'ACCOUNT_NOT_FOUND' };

  const [sub] = await db
    .select({
      stripeSubscriptionId: accountSubscriptions.stripeSubscriptionId,
      status: accountSubscriptions.status,
      cancelAtPeriodEnd: accountSubscriptions.cancelAtPeriodEnd,
    })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, accountId))
    .limit(1);
  if (hasBillingStripeSubscription(sub)) {
    return { ok: false, code: 'STRIPE_SUBSCRIPTION_ACTIVE', stripeSubscriptionId: sub!.stripeSubscriptionId! };
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
