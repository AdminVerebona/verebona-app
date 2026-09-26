/**
 * Cycle d'impayé de 90 jours — écritures et balayage quotidien.
 * Règles et lectures retenues : voir `unpaid-cycle.rules.ts` (GAP-06,
 * AID-BILL-008, AID-TRANSFER-006).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * OÙ VIT LE CYCLE
 *
 *   accounts.past_due_grace_started_at   J0 (NULL hors cycle)
 *   accounts.past_due_grace_ends_at      J+90
 *   account_subscriptions.status         'past_due' → droits restreints
 *                                        (entitlements : lecture, export,
 *                                        transmission ; ni écriture ni IA)
 *
 * Les colonnes « grace » portaient une période de grâce de 15 jours pendant
 * laquelle tout restait permis — contraire à la règle cible (suspension dès
 * J0). Elles portent désormais le cycle de 90 jours.
 *
 * Ouverture : webhook `invoice.payment_failed` (et, si l'ordre des
 * événements l'inverse, synchronisation d'un abonnement `past_due`).
 * Fermeture : paiement confirmé — `syncSubscriptionFromStripe` remet les
 * colonnes à NULL et le statut à `active`.
 * Issue J+90 : `runUnpaidCycleSweep` (cron quotidien, idempotent).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { accounts, accountSubscriptions } from '@/db/schema';
import { getStripeServer } from '@/lib/stripe';
import { emit } from '@/lib/notifications';
import {
  executeScheduledDeletion,
  getActiveSchedule,
  scheduleDeletion,
} from '@/services/account/scheduled-deletion.service';
import { syncSubscriptionFromStripe } from '@/services/billing/subscription-sync.service';
import { buildFingerprint, reportAnomaly } from '@/services/admin/anomaly.service';
import { computeUnpaidCycle, decideAtDeadline, unpaidDeadline, UNPAID_CYCLE_DAYS } from './unpaid-cycle.rules';

/** Statuts de compte qu'un échec de paiement fait passer en cycle d'impayé. */
const PAID_ACCOUNT_STATUSES = ['ACTIVE', 'PAST_DUE', 'PAST_DUE_GRACE', 'CANCELED'];

/**
 * Ouvre le cycle (J0) s'il ne l'est pas déjà, et restreint les droits.
 * Idempotent : J0 n'est jamais déplacé par une nouvelle tentative échouée.
 * @returns J0 et l'échéance du cycle en cours, ou `null` si compte inconnu.
 */
export async function startUnpaidCycle(
  accountId: number,
  at: Date = new Date(),
): Promise<{ startedAt: Date; deadlineAt: Date } | null> {
  const atIso = at.toISOString();
  const rows = await db
    .update(accounts)
    .set({
      pastDueGraceStartedAt: sql`COALESCE(${accounts.pastDueGraceStartedAt}, ${atIso}::timestamptz)`,
      // Cycle déjà ouvert : échéance inchangée (elle a pu être reportée par
      // la migration 0182 pour les cycles antérieurs à la règle).
      pastDueGraceEndsAt: sql`CASE WHEN ${accounts.pastDueGraceStartedAt} IS NULL
        THEN ${atIso}::timestamptz + make_interval(days => ${UNPAID_CYCLE_DAYS})
        ELSE COALESCE(${accounts.pastDueGraceEndsAt}, ${accounts.pastDueGraceStartedAt} + make_interval(days => ${UNPAID_CYCLE_DAYS})) END`,
      // Un compte rétracté ou déjà expiré garde son statut propre.
      subscriptionStatus: sql`CASE WHEN ${accounts.subscriptionStatus} IN (${sql.join(
        PAID_ACCOUNT_STATUSES.map((s) => sql`${s}`),
        sql`, `,
      )}) THEN 'PAST_DUE_GRACE' ELSE ${accounts.subscriptionStatus} END`,
      updatedAt: at,
    })
    .where(eq(accounts.id, accountId))
    .returning({ startedAt: accounts.pastDueGraceStartedAt, endsAt: accounts.pastDueGraceEndsAt });

  const startedAt = rows[0]?.startedAt;
  if (!startedAt) return null;
  const deadlineAt = rows[0].endsAt ?? unpaidDeadline(startedAt);

  // J0 : suspension des fonctions normales (entitlements lit ce statut).
  await db
    .update(accountSubscriptions)
    .set({ status: 'past_due', updatedAt: at })
    .where(and(
      eq(accountSubscriptions.accountId, accountId),
      inArray(accountSubscriptions.status, ['active', 'past_due']),
    ));

  return { startedAt, deadlineAt };
}

// ─── Balayage quotidien ──────────────────────────────────────────────────────

export interface UnpaidSweepResult {
  scanned: number;
  reminders: number;
  regularized: number;
  deleted: number;
  deferred: Array<{ accountId: number; reason: string }>;
  failed: Array<{ accountId: number; reason: string }>;
}

interface Candidate {
  accountId: number;
  ownerUserId: number;
  startedAt: Date;
  deadlineAt: Date | null;
  accountStatus: string;
  stripeCustomerId: string | null;
}

async function loadCandidates(): Promise<Candidate[]> {
  const rows = await db
    .select({
      accountId: accounts.id,
      ownerUserId: accounts.ownerUserId,
      startedAt: accounts.pastDueGraceStartedAt,
      deadlineAt: accounts.pastDueGraceEndsAt,
      accountStatus: accounts.subscriptionStatus,
      stripeCustomerId: accounts.stripeCustomerId,
    })
    .from(accounts)
    .where(isNotNull(accounts.pastDueGraceStartedAt));
  return rows.filter((r): r is Candidate => r.startedAt !== null);
}

/** Dépendances injectables (tests). */
export interface UnpaidSweepDeps {
  stripe: () => Pick<Stripe, 'subscriptions'>;
}

const defaultDeps: UnpaidSweepDeps = { stripe: getStripeServer };

/** Clé de déduplication d'un rappel : une par cycle et par étape. */
export function unpaidReminderDedupeKey(accountId: number, startedAt: Date, stage: string): string {
  return `account:unpaid-cycle:${accountId}:${startedAt.toISOString()}:${stage}`;
}

/**
 * Balayage quotidien du cycle. Idempotent : rappels dédupliqués par cycle et
 * par étape ; suppression par le workflow unique (compte à rebours unique
 * par compte, exécution sans effet si déjà faite).
 */
export async function runUnpaidCycleSweep(
  options: { now?: Date; dryRun?: boolean } = {},
  deps: UnpaidSweepDeps = defaultDeps,
): Promise<UnpaidSweepResult> {
  const now = options.now ?? new Date();
  const dryRun = Boolean(options.dryRun);
  const result: UnpaidSweepResult = { scanned: 0, reminders: 0, regularized: 0, deleted: 0, deferred: [], failed: [] };

  for (const c of await loadCandidates()) {
    result.scanned += 1;

    // Régularisé mais colonnes non remises à zéro (chemin historique) : on
    // referme le cycle plutôt que de supprimer un client à jour.
    if (c.accountStatus === 'ACTIVE' || c.accountStatus === 'TRIALING') {
      if (!dryRun) await closeUnpaidCycle(c.accountId, now);
      result.regularized += 1;
      continue;
    }

    const state = computeUnpaidCycle(c.startedAt, now, c.deadlineAt);

    if (state.step.kind === 'reminder') {
      if (!dryRun) {
        try {
          await emit({
            type: 'ACCOUNT_READ_ONLY',
            accountId: c.accountId,
            entityType: 'account',
            entityId: c.accountId,
            payload: {
              accountId: c.accountId,
              reason: 'unpaid',
              deadlineAt: state.deadlineAt.toISOString(),
              daysLeft: state.daysLeft,
            },
            dedupeKey: unpaidReminderDedupeKey(c.accountId, c.startedAt, state.step.stage),
          });
        } catch (e) {
          console.error(`[unpaid-cycle] rappel ${state.step.stage} du compte ${c.accountId} :`, (e as Error).message);
        }
      }
      result.reminders += 1;
      continue;
    }

    if (state.step.kind !== 'expired') continue;

    try {
      const outcome = await settleExpiredCycle(c, now, dryRun, deps);
      if (outcome === 'deleted') result.deleted += 1;
      else if (outcome === 'regularized') result.regularized += 1;
      else result.deferred.push({ accountId: c.accountId, reason: outcome });
    } catch (e) {
      const reason = (e as Error).message;
      result.failed.push({ accountId: c.accountId, reason });
      console.error(`[unpaid-cycle] compte ${c.accountId} : ${reason}`);
      // Supervision (CDC BO SUP) : la suppression à échéance n'a pas eu lieu.
      await reportAnomaly({
        domain: 'stripe',
        fingerprint: buildFingerprint('stripe', 'unpaid-cycle', c.accountId),
        title: 'Cycle d’impayé : suppression à J+90 non exécutée',
        accountId: c.accountId,
        detail: { reason },
      });
    }
  }
  return result;
}

/** Referme le cycle (régularisation constatée). */
export async function closeUnpaidCycle(accountId: number, now: Date = new Date()): Promise<void> {
  await db
    .update(accounts)
    .set({ pastDueGraceStartedAt: null, pastDueGraceEndsAt: null, updatedAt: now })
    .where(eq(accounts.id, accountId));
}

type SettleOutcome = 'deleted' | 'regularized' | 'OTHER_DELETION_PENDING' | 'WITHDRAWN' | 'DRY_RUN' | 'STRIPE_UNREACHABLE';

/**
 * J+90 : revérifie chez Stripe, puis résilie ce qui facture encore et
 * supprime par le workflow unique (motif UNPAID, origine système).
 */
async function settleExpiredCycle(
  c: Candidate,
  now: Date,
  dryRun: boolean,
  deps: UnpaidSweepDeps,
): Promise<SettleOutcome> {
  // La rétractation a son propre parcours (30 jours d'export).
  if (c.accountStatus === 'WITHDRAWN') return 'WITHDRAWN';

  const existing = await getActiveSchedule(c.accountId);
  if (existing && existing.reason !== 'UNPAID') return 'OTHER_DELETION_PENDING';

  // ── Revérification Stripe : jamais de suppression sur un état local seul ──
  let subs: Stripe.Subscription[] = [];
  if (c.stripeCustomerId) {
    try {
      const list = await deps.stripe().subscriptions.list({ customer: c.stripeCustomerId, status: 'all', limit: 20 });
      subs = list.data;
    } catch (e) {
      console.warn(`[unpaid-cycle] compte ${c.accountId} : Stripe injoignable, report (${(e as Error).message})`);
      return 'STRIPE_UNREACHABLE';
    }
  }

  const decision = decideAtDeadline(subs.map((s) => ({ id: s.id, status: s.status })));
  if (decision.action === 'regularized') {
    if (!dryRun) {
      const sub = subs.find((s) => s.id === decision.subscriptionId)!;
      await syncSubscriptionFromStripe({ subscription: sub, source: 'cron:unpaid-cycle', accountIdHint: c.accountId, notify: false });
      await closeUnpaidCycle(c.accountId, now);
    }
    return 'regularized';
  }

  if (dryRun) return 'DRY_RUN';

  // Un client dont les données sont supprimées ne doit plus être prélevé.
  for (const id of decision.cancelFirst) {
    await deps.stripe().subscriptions.cancel(id, { invoice_now: false, prorate: false });
  }

  const schedule = existing ?? await scheduleDeletion({
    accountId: c.accountId,
    userId: c.ownerUserId,
    reason: 'UNPAID',
    origin: 'system',
    confirmedAt: now,
    delayDays: 0,
  });
  if (schedule.reason !== 'UNPAID') return 'OTHER_DELETION_PENDING';

  const execution = await executeScheduledDeletion(schedule.id, { now });
  if (execution.status === 'executed') return 'deleted';
  throw new Error(`suppression ${execution.status}${execution.reason ? ` : ${execution.reason}` : ''}`);
}
