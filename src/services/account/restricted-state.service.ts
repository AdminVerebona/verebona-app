/**
 * Lot 102A — ÉTAT RESTREINT du compte : modèle unique, entrée, levée,
 * lecture (Mon compte, BO), rattrapage et supervision.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL MODÈLE, PORTÉ PAR LE MOTEUR DE PURGE EXISTANT
 *
 * L'état restreint d'un compte = son compte à rebours de suppression actif
 * (`scheduled_account_deletions`, moteur unique et idempotent
 * `executeScheduledDeletion`) dont le motif relève du cycle de vie :
 *
 *   motif (retention-policy)   compte à rebours      portée    annulé par
 *   FIN_ESSAI                  TRIAL_ABANDONED       account   souscription
 *   FIN_ABONNEMENT             SUBSCRIPTION_ENDED    account   souscription
 *   RETRACTATION               WITHDRAWAL            account   souscription
 *   SUPPRESSION_DEMANDEE       VOLUNTARY             user      l'utilisateur
 *
 * Date d'entrée = `confirmed_at` ; date de suppression = `scheduled_at`
 * (figée à l'écriture, jamais recalculée : elle est annoncée par écrit).
 * La lecture seule elle-même n'est PAS décidée ici : elle découle de l'état
 * de l'abonnement (`entitlements`, `processing-eligibility`), règle unique
 * des droits et des traitements IA. Ce service ne fait que programmer,
 * annuler et décrire la purge.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db, pgClient } from '@/db';
import { accounts, scheduledAccountDeletions } from '@/db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  DELETION_REASON_OF,
  LIFECYCLE_DURATIONS,
  RESTRICTED_REASON_LABELS,
  cancelledBySubscription,
  daysUntilPurge,
  purgeDateFor,
  restrictedReasonOf,
  type RestrictedReason,
} from '@/lib/account-lifecycle/retention-policy';
import {
  cancelDeletion,
  getActiveSchedule,
  getActiveUserSchedule,
  scheduleDeletion,
  type DeletionReason,
  type ScheduledDeletion,
} from './scheduled-deletion.service';
import { canExportInRestrictedState, type RestrictedAccountState } from '@/services/gdpr/restricted-export-access';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Motifs de compte à rebours annulés par une (re)souscription. */
export const PURGES_CANCELLED_BY_SUBSCRIPTION: readonly DeletionReason[] = (
  ['FIN_ESSAI', 'FIN_ABONNEMENT', 'RETRACTATION'] as const
).filter(cancelledBySubscription).map((r) => DELETION_REASON_OF[r]);

const LIFECYCLE_DELETION_REASONS: readonly DeletionReason[] = Object.values(DELETION_REASON_OF);

export interface RestrictedStateView {
  reason: RestrictedReason;
  label: string;
  enteredAt: string;
  purgeAt: string;
  daysLeft: number;
  scheduleId: number;
  /** Une souscription avant l'échéance annule la purge. */
  cancelledBySubscription: boolean;
  /** Raccord 102C : l'export « Mes données » reste ouvert dans cet état (règle unique). */
  exportAllowed: boolean;
}

/** Raccord 102A → 102C : motif du cycle de vie → état restreint de la garde d'export. */
export const EXPORT_STATE_OF: Readonly<Record<RestrictedReason, RestrictedAccountState>> = {
  FIN_ESSAI: 'trial_readonly',
  FIN_ABONNEMENT: 'subscription_ended_readonly',
  RETRACTATION: 'withdrawal_readonly',
  SUPPRESSION_DEMANDEE: 'pending_deletion',
};

function viewOf(s: Pick<ScheduledDeletion, 'id' | 'reason' | 'confirmedAt' | 'scheduledAt'>, now: Date): RestrictedStateView | null {
  const reason = restrictedReasonOf(s.reason);
  if (!reason) return null;
  return {
    reason,
    label: RESTRICTED_REASON_LABELS[reason],
    enteredAt: s.confirmedAt.toISOString(),
    purgeAt: s.scheduledAt.toISOString(),
    daysLeft: daysUntilPurge(s.scheduledAt, now),
    scheduleId: s.id,
    cancelledBySubscription: cancelledBySubscription(reason),
    exportAllowed: canExportInRestrictedState(EXPORT_STATE_OF[reason]),
  };
}

/* ── Entrée ─────────────────────────────────────────────────────────────── */

type EnterResult =
  | { status: 'scheduled' | 'existing'; schedule: ScheduledDeletion }
  | { status: 'skipped'; reason: 'ACCOUNT_GONE' | 'WITHDRAWN' | 'UNPAID_CYCLE' | 'OTHER_DELETION_PENDING'; schedule?: ScheduledDeletion };

/**
 * Entrée en état restreint (fin d'essai, fin d'abonnement, rétractation) :
 * purge programmée à `enteredAt` + 90 jours. Idempotente : un compte à
 * rebours déjà actif est rendu tel quel (jamais de date déplacée).
 *
 * Ne lève pas pour un cas métier (compte disparu, autre parcours en cours) ;
 * une erreur de base remonte à l'appelant (qui décide : reprise, journal).
 */
export async function enterRestrictedState(input: {
  accountId: number;
  reason: Exclude<RestrictedReason, 'SUPPRESSION_DEMANDEE'>;
  enteredAt: Date;
  userId?: number | null;
  /** Rattrapage : préavis minimal à compter de cet instant (`backfillMinNoticeDays`). */
  minNoticeFrom?: Date;
}): Promise<EnterResult> {
  const [acc] = await db
    .select({ id: accounts.id, owner: accounts.ownerUserId, status: accounts.subscriptionStatus, unpaid: accounts.unpaidStartedAt })
    .from(accounts)
    .where(eq(accounts.id, input.accountId))
    .limit(1);
  if (!acc) return { status: 'skipped', reason: 'ACCOUNT_GONE' };

  // La rétractation a son propre état (RETRACTATION) : une fin d'abonnement
  // constatée ensuite (webhook de l'annulation) ne le remplace pas.
  if (input.reason !== 'RETRACTATION' && acc.status === 'WITHDRAWN') return { status: 'skipped', reason: 'WITHDRAWN' };
  // Impayé : le cycle de 90 jours (GAP-06) porte déjà la suppression.
  if (input.reason === 'FIN_ABONNEMENT' && acc.unpaid) return { status: 'skipped', reason: 'UNPAID_CYCLE' };

  const existing = await getActiveSchedule(acc.id);
  if (existing) {
    return restrictedReasonOf(existing.reason)
      ? { status: 'existing', schedule: existing }
      : { status: 'skipped', reason: 'OTHER_DELETION_PENDING', schedule: existing };
  }

  const schedule = await scheduleDeletion({
    accountId: acc.id,
    userId: input.userId ?? acc.owner,
    reason: DELETION_REASON_OF[input.reason],
    // Conservation échue : traitement système, pas l'exercice d'un droit
    // (aucune demande RGPD créée — `deletionCreatesGdprRequest`).
    origin: 'system',
    confirmedAt: input.enteredAt,
    scheduledAt: purgeDateFor(input.reason, input.enteredAt, { minNoticeFrom: input.minNoticeFrom }),
  });
  console.info(
    `[account-lifecycle] compte ${acc.id} : état restreint ${input.reason}, entrée ${input.enteredAt.toISOString()}, ` +
    `suppression programmée le ${schedule.scheduledAt.toISOString()}.`,
  );
  return { status: schedule.reason === DELETION_REASON_OF[input.reason] ? 'scheduled' : 'existing', schedule };
}

/** Variante qui ne lève jamais (webhooks, tâches) : erreur journalisée. */
export async function enterRestrictedStateSafe(input: Parameters<typeof enterRestrictedState>[0]): Promise<EnterResult | null> {
  try {
    return await enterRestrictedState(input);
  } catch (e) {
    console.error(`[account-lifecycle] compte ${input.accountId} : entrée en état restreint (${input.reason}) impossible —`, (e as Error).message);
    return null;
  }
}

/* ── Levée ──────────────────────────────────────────────────────────────── */

/**
 * (Re)souscription : la purge programmée d'un état restreint est ANNULÉE
 * (fin d'essai, fin d'abonnement, rétractation). Jamais une suppression
 * engagée par le back-office, un impayé ou une suppression demandée.
 * Idempotente ; ne lève jamais.
 */
export async function liftRestrictedState(accountId: number, cause: string): Promise<ScheduledDeletion | null> {
  try {
    const cancelled = await cancelDeletion(accountId, cause, { onlyReasons: PURGES_CANCELLED_BY_SUBSCRIPTION });
    if (cancelled) console.info(`[account-lifecycle] compte ${accountId} : purge annulée (${cause}).`);
    return cancelled;
  } catch (e) {
    console.error(`[account-lifecycle] compte ${accountId} : annulation de la purge impossible —`, (e as Error).message);
    return null;
  }
}

/* ── Lecture ────────────────────────────────────────────────────────────── */

/**
 * État restreint courant d'un compte (bandeau Mon compte) : purge d'un état
 * restreint de portée compte, sinon suppression demandée par le titulaire.
 */
export async function getRestrictedState(accountId: number, now: Date = new Date()): Promise<RestrictedStateView | null> {
  const active = await getActiveSchedule(accountId);
  if (active) {
    const v = viewOf(active, now);
    if (v) return v;
  }
  const [acc] = await db.select({ owner: accounts.ownerUserId }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!acc) return null;
  const voluntary = await getActiveUserSchedule(acc.owner);
  return voluntary ? viewOf(voluntary, now) : null;
}

export interface AdminRestrictedState {
  current: RestrictedStateView | null;
  /** Derniers comptes à rebours du cycle de vie (tous états) : annulations visibles. */
  history: Array<{
    id: number;
    reason: RestrictedReason | null;
    reasonCode: string;
    status: string;
    enteredAt: string;
    purgeAt: string;
    cancelledAt: string | null;
    cancellationReason: string | null;
    executedAt: string | null;
  }>;
}

/** Fiche Compte du BO : état restreint, date de purge, annulations (lecture seule). */
export async function getAdminRestrictedState(accountId: number, ownerUserId: number | null, now: Date = new Date()): Promise<AdminRestrictedState> {
  const current = await getRestrictedState(accountId, now);
  const rows = await db
    .select()
    .from(scheduledAccountDeletions)
    .where(and(eq(scheduledAccountDeletions.accountId, accountId), inArray(scheduledAccountDeletions.reason, [...LIFECYCLE_DELETION_REASONS])))
    .orderBy(desc(scheduledAccountDeletions.id))
    .limit(5);
  const own = rows.filter((r) => r.scope === 'account' || (ownerUserId != null && r.userId === ownerUserId) || r.userId == null);
  return {
    current,
    history: own.map((r) => ({
      id: r.id,
      reason: restrictedReasonOf(r.reason),
      reasonCode: r.reason,
      status: r.status,
      enteredAt: r.confirmedAt.toISOString(),
      purgeAt: r.scheduledAt.toISOString(),
      cancelledAt: r.cancelledAt?.toISOString() ?? null,
      cancellationReason: r.cancellationReason ?? null,
      executedAt: r.executedAt?.toISOString() ?? null,
    })),
  };
}

/* ── Rattrapage : fins d'essai sans purge programmée ───────────────────── */

/**
 * Essais terminés sans souscription et sans purge programmée : la fin
 * d'essai de l'heure (tâche `expire-trials`) ET les comptes déjà en lecture
 * seule avant la livraison du lot 102A. Date = fin d'essai + 90 jours, et
 * jamais moins de `backfillMinNoticeDays` après maintenant (aucune purge sans
 * préavis pour un compte qui n'avait reçu aucune date).
 *
 * Un compte dont une purge de fin d'essai a déjà existé (annulée par une
 * souscription, exécutée, en échec) n'est jamais reprogrammé ici.
 */
export async function scheduleTrialPurges(opts: { now?: Date; limit?: number; accountIds?: number[] } = {}): Promise<{ examined: number; scheduled: number }> {
  const now = opts.now ?? new Date();
  const rows = await pgClient<{ account_id: number; trial_ends_at: Date; owner_user_id: number }[]>`
    SELECT s.account_id, s.trial_ends_at, a.owner_user_id
      FROM account_subscriptions s
      JOIN accounts a ON a.id = s.account_id
     WHERE s.trial_ends_at IS NOT NULL AND s.trial_ends_at <= ${now.toISOString()}
       AND s.first_billed_at IS NULL
       AND s.status IN ('trialing', 'readonly', 'canceled')
       AND coalesce(a.subscription_status, '') <> 'WITHDRAWN'
       ${opts.accountIds ? pgClient`AND s.account_id IN ${pgClient(opts.accountIds.length ? opts.accountIds : [-1])}` : pgClient``}
       AND NOT EXISTS (SELECT 1 FROM scheduled_account_deletions d
                        WHERE d.account_id = s.account_id AND d.reason = 'TRIAL_ABANDONED')
       AND NOT EXISTS (SELECT 1 FROM scheduled_account_deletions d
                        WHERE d.account_id = s.account_id AND d.status = 'SCHEDULED' AND d.scope = 'account')
     ORDER BY s.trial_ends_at, s.account_id
     LIMIT ${opts.limit ?? 500}`;
  let scheduled = 0;
  for (const r of rows) {
    const res = await enterRestrictedStateSafe({
      accountId: r.account_id,
      userId: r.owner_user_id,
      reason: 'FIN_ESSAI',
      enteredAt: new Date(r.trial_ends_at),
      minNoticeFrom: now,
    });
    if (res?.status === 'scheduled') scheduled += 1;
  }
  return { examined: rows.length, scheduled };
}

/* ── Supervision ────────────────────────────────────────────────────────── */

export interface LifecycleSupervision {
  byReason: Array<{
    reason: RestrictedReason;
    label: string;
    scheduled: number;
    dueWithin7Days: number;
    overdue: number;
    executed30d: number;
    cancelled30d: number;
    failed30d: number;
  }>;
  /** Suppressions volontaires au-delà du plafond technique (30 jours). */
  voluntaryOverCeiling: number;
  registry: { entries: number; lastExecutedAt: string | null };
}

export async function getLifecycleSupervision(now: Date = new Date()): Promise<LifecycleSupervision> {
  const overdueBefore = new Date(now.getTime() - LIFECYCLE_DURATIONS.overdueToleranceHours * HOUR_MS).toISOString();
  const soon = new Date(now.getTime() + 7 * DAY_MS).toISOString();
  const since = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const ceiling = new Date(now.getTime() - LIFECYCLE_DURATIONS.voluntaryDeletionMaxDays * DAY_MS).toISOString();
  const rows = await pgClient<{ reason: string; scheduled: number; due7: number; overdue: number; executed: number; cancelled: number; failed: number }[]>`
    SELECT reason,
           count(*) FILTER (WHERE status = 'SCHEDULED')::int AS scheduled,
           count(*) FILTER (WHERE status = 'SCHEDULED' AND scheduled_at <= ${soon})::int AS due7,
           count(*) FILTER (WHERE status = 'SCHEDULED' AND scheduled_at <= ${overdueBefore})::int AS overdue,
           count(*) FILTER (WHERE status = 'EXECUTED' AND executed_at >= ${since})::int AS executed,
           count(*) FILTER (WHERE status = 'CANCELLED' AND cancelled_at >= ${since})::int AS cancelled,
           count(*) FILTER (WHERE status = 'FAILED' AND updated_at >= ${since})::int AS failed
      FROM scheduled_account_deletions
     WHERE reason IN ${pgClient([...LIFECYCLE_DELETION_REASONS])}
     GROUP BY reason`;
  const [over] = await pgClient<{ n: number }[]>`
    SELECT count(*)::int AS n FROM scheduled_account_deletions
     WHERE reason = 'VOLUNTARY' AND status = 'SCHEDULED' AND confirmed_at < ${ceiling}`;
  const [reg] = await pgClient<{ n: number; last: Date | null }[]>`
    SELECT count(*)::int AS n, max(executed_at) AS last FROM account_deletion_registry`;
  const byCode = new Map(rows.map((r) => [r.reason, r]));
  return {
    byReason: (Object.keys(DELETION_REASON_OF) as RestrictedReason[]).map((reason) => {
      const r = byCode.get(DELETION_REASON_OF[reason]);
      return {
        reason, label: RESTRICTED_REASON_LABELS[reason],
        scheduled: Number(r?.scheduled ?? 0), dueWithin7Days: Number(r?.due7 ?? 0), overdue: Number(r?.overdue ?? 0),
        executed30d: Number(r?.executed ?? 0), cancelled30d: Number(r?.cancelled ?? 0), failed30d: Number(r?.failed ?? 0),
      };
    }),
    voluntaryOverCeiling: Number(over?.n ?? 0),
    registry: { entries: Number(reg?.n ?? 0), lastExecutedAt: reg?.last ? new Date(reg.last).toISOString() : null },
  };
}

/**
 * Anomalies de Supervision du cycle de vie (consolidées par empreinte,
 * résolues automatiquement quand la situation redevient normale) :
 * purge en retard, suppression volontaire au-delà du plafond technique.
 */
export async function reportLifecycleAnomalies(now: Date = new Date()): Promise<{ overdue: number; voluntaryOverCeiling: number }> {
  const sup = await getLifecycleSupervision(now);
  const overdue = sup.byReason.reduce((n, r) => n + r.overdue, 0);
  const { reportAnomaly, autoResolveAnomaly, buildFingerprint } = await import('@/services/admin/anomaly.service');
  const fpOverdue = buildFingerprint('other', 'account-lifecycle', 'purge-overdue');
  const fpCeiling = buildFingerprint('other', 'account-lifecycle', 'voluntary-ceiling');
  if (overdue > 0) {
    await reportAnomaly({
      domain: 'other', fingerprint: fpOverdue,
      title: 'Purge de compte non exécutée à l’échéance (cycle de vie)',
      detail: { overdue, byReason: sup.byReason.filter((r) => r.overdue > 0).map((r) => ({ reason: r.reason, overdue: r.overdue })) },
    });
  } else {
    await autoResolveAnomaly(fpOverdue, { origin: 'account-lifecycle', cause: 'Plus aucune purge en retard.' });
  }
  if (sup.voluntaryOverCeiling > 0) {
    await reportAnomaly({
      domain: 'other', fingerprint: fpCeiling,
      title: `Suppression demandée non exécutée après ${LIFECYCLE_DURATIONS.voluntaryDeletionMaxDays} jours (plafond technique)`,
      detail: { count: sup.voluntaryOverCeiling },
    });
  } else {
    await autoResolveAnomaly(fpCeiling, { origin: 'account-lifecycle', cause: 'Plus aucune suppression au-delà du plafond.' });
  }
  return { overdue, voluntaryOverCeiling: sup.voluntaryOverCeiling };
}

/* ── Fin d'abonnement payant ───────────────────────────────────────────── */

/**
 * Fin EFFECTIVE d'un abonnement payant (webhook `customer.subscription.deleted`,
 * synchronisation d'un abonnement terminé) : état restreint FIN_ABONNEMENT,
 * purge à la date de fin + 90 jours. Seulement si le compte a réellement été
 * facturé (un essai jamais payé relève de la fin d'essai) et n'a pas de
 * nouvel abonnement en cours. Ne lève jamais.
 */
export async function onPaidSubscriptionEnded(accountId: number, endedAt: Date | null, now: Date = new Date()): Promise<EnterResult | null> {
  try {
    const [row] = await pgClient<{ first_billed_at: Date | null; status: string | null }[]>`
      SELECT first_billed_at, status FROM account_subscriptions WHERE account_id = ${accountId} LIMIT 1`;
    if (!row?.first_billed_at) return null;
    if (row.status && ['active', 'trialing', 'past_due'].includes(row.status)) return null;
    return await enterRestrictedState({ accountId, reason: 'FIN_ABONNEMENT', enteredAt: endedAt ?? now });
  } catch (e) {
    console.error(`[account-lifecycle] compte ${accountId} : fin d'abonnement non programmée —`, (e as Error).message);
    return null;
  }
}
