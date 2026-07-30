/**
 * Suppression planifiée de compte — CDC rétractation §13.3, §17, §21.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'EXÉCUTION NE TIENT PAS UNE LISTE DE TABLES
 *
 * Supprimer un compte pourrait s'écrire comme une suite de `DELETE` sur les
 * quarante tables qui le référencent. Cette liste serait fausse au premier
 * ajout de table, et personne ne s'en apercevrait : il ne resterait que des
 * données orphelines, invisibles, dans un système censé les avoir effacées.
 *
 * L'exécution supprime donc l'utilisateur titulaire, et laisse les contraintes
 * `ON DELETE CASCADE` déjà déclarées faire le travail. Le schéma reste la
 * seule source de vérité, et une nouvelle table est prise en compte sans
 * qu'on y pense.
 *
 * Le revers, c'est qu'une cascade emporte aussi ce qui doit survivre. D'où le
 * garde-fou : les preuves à conserver sont comptées avant, dénombrées après,
 * et toute disparition annule la transaction entière.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import {
  accountMemberships,
  accounts,
  legalAcceptances,
  scheduledAccountDeletions,
  users,
} from '@/db/schema';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';

/** Délai avant suppression effective, en jours (§13.3). */
export const DELETION_DELAY_DAYS = 30;

export type DeletionReason = 'WITHDRAWAL' | 'VOLUNTARY' | 'TRIAL_ABANDONED';
export type DeletionStatus = 'SCHEDULED' | 'CANCELLED' | 'EXECUTED' | 'FAILED';

export interface ScheduledDeletion {
  id: number;
  accountId: number;
  userId: number | null;
  reason: DeletionReason;
  confirmedAt: Date;
  scheduledAt: Date;
  status: DeletionStatus;
  reminderJ7SentAt: Date | null;
  reminderJ1SentAt: Date | null;
}

export class DeletionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DeletionError';
  }
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/* ── Planification ─────────────────────────────────────────────────────── */

export interface ScheduleInput {
  accountId: number;
  userId: number;
  reason: DeletionReason;
  /** Instant de référence. `scheduledAt` en découle et n'est jamais recalculé. */
  confirmedAt?: Date;
  delayDays?: number;
}

/**
 * Ouvre un compte à rebours de suppression.
 *
 * Idempotent : si un compte à rebours est déjà en cours pour ce compte, il est
 * retourné tel quel. Replanifier raccourcirait ou allongerait un délai déjà
 * annoncé à l'utilisateur par courriel — ce qui n'est pas acceptable pour une
 * date qu'il a reçue par écrit.
 */
export async function scheduleDeletion(input: ScheduleInput): Promise<ScheduledDeletion> {
  const confirmedAt = input.confirmedAt ?? new Date();
  const scheduledAt = addDays(confirmedAt, input.delayDays ?? DELETION_DELAY_DAYS);

  const inserted = await db
    .insert(scheduledAccountDeletions)
    .values({
      accountId: input.accountId,
      userId: input.userId,
      reason: input.reason,
      confirmedAt,
      scheduledAt,
      status: 'SCHEDULED',
      createdAt: confirmedAt,
      updatedAt: confirmedAt,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length > 0) return toScheduled(inserted[0]);

  const existing = await getActiveSchedule(input.accountId);
  if (!existing) {
    throw new DeletionError('SCHEDULE_FAILED', `Planification impossible pour le compte ${input.accountId}.`);
  }
  return existing;
}

function toScheduled(row: typeof scheduledAccountDeletions.$inferSelect): ScheduledDeletion {
  return {
    id: row.id,
    accountId: row.accountId,
    userId: row.userId ?? null,
    reason: row.reason as DeletionReason,
    confirmedAt: row.confirmedAt,
    scheduledAt: row.scheduledAt,
    status: row.status as DeletionStatus,
    reminderJ7SentAt: row.reminderJ7SentAt ?? null,
    reminderJ1SentAt: row.reminderJ1SentAt ?? null,
  };
}

/** Compte à rebours en cours pour un compte, s'il y en a un. */
export async function getActiveSchedule(accountId: number): Promise<ScheduledDeletion | null> {
  const [row] = await db
    .select()
    .from(scheduledAccountDeletions)
    .where(
      and(
        eq(scheduledAccountDeletions.accountId, accountId),
        eq(scheduledAccountDeletions.status, 'SCHEDULED'),
      ),
    )
    .limit(1);
  return row ? toScheduled(row) : null;
}

/**
 * Annule un compte à rebours.
 *
 * Appelée notamment lorsqu'une nouvelle souscription est conclue (§13.3 :
 * « annulation automatique de la suppression si une nouvelle souscription est
 * conclue », et scénario n°21).
 *
 * NE LÈVE PAS lorsqu'il n'y a rien à annuler : l'appelant est souvent un
 * webhook, pour lequel l'absence de compte à rebours est le cas nominal.
 */
export async function cancelDeletion(
  accountId: number,
  reason: string,
): Promise<ScheduledDeletion | null> {
  const now = new Date();
  const [row] = await db
    .update(scheduledAccountDeletions)
    .set({
      status: 'CANCELLED',
      cancelledAt: now,
      cancellationReason: reason,
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledAccountDeletions.accountId, accountId),
        eq(scheduledAccountDeletions.status, 'SCHEDULED'),
      ),
    )
    .returning();

  if (row) {
    console.info(
      `[deletion] compte ${accountId} : suppression annulée (${reason}), ` +
      `échéance ${row.scheduledAt.toISOString()} abandonnée.`,
    );
  }
  return row ? toScheduled(row) : null;
}

/* ── Balayage ──────────────────────────────────────────────────────────── */

/**
 * Quel rappel est dû pour ce compte à rebours, à cet instant ?
 *
 * Pure et sans base : c'est ici que se concentre toute la règle du §13.3, donc
 * ici qu'elle doit être vérifiable.
 *
 * L'ordre des conditions compte. À moins de vingt-quatre heures de l'échéance,
 * seul le rappel J-1 a du sens : envoyer les deux le même jour serait du bruit,
 * et un compte à rebours créé à moins de sept jours de son échéance ne doit pas
 * déclencher un rappel « dans sept jours » manifestement faux.
 */
export function selectDueReminder(
  item: Pick<ScheduledDeletion, 'scheduledAt' | 'reminderJ7SentAt' | 'reminderJ1SentAt'>,
  now: Date,
): 'j7' | 'j1' | null {
  // Échéance dépassée : plus de rappel, c'est la suppression qui s'applique.
  if (item.scheduledAt <= now) return null;

  if (item.scheduledAt <= addDays(now, 1)) {
    return item.reminderJ1SentAt ? null : 'j1';
  }
  if (item.scheduledAt <= addDays(now, 7)) {
    return item.reminderJ7SentAt ? null : 'j7';
  }
  return null;
}

/** Comptes à rebours dont un rappel est dû (§13.3). */
export async function listDueReminders(now: Date = new Date()): Promise<{
  j7: ScheduledDeletion[];
  j1: ScheduledDeletion[];
}> {
  const rows = await db
    .select()
    .from(scheduledAccountDeletions)
    .where(eq(scheduledAccountDeletions.status, 'SCHEDULED'));

  const j7: ScheduledDeletion[] = [];
  const j1: ScheduledDeletion[] = [];

  for (const row of rows) {
    const item = toScheduled(row);
    const due = selectDueReminder(item, now);
    if (due === 'j7') j7.push(item);
    else if (due === 'j1') j1.push(item);
  }

  return { j7, j1 };
}

/** Marque un rappel comme envoyé. */
export async function markReminderSent(
  id: number,
  which: 'j7' | 'j1',
  at: Date = new Date(),
): Promise<void> {
  await db
    .update(scheduledAccountDeletions)
    .set({
      ...(which === 'j7' ? { reminderJ7SentAt: at } : { reminderJ1SentAt: at }),
      updatedAt: at,
    })
    .where(eq(scheduledAccountDeletions.id, id));
}

/** Comptes à rebours arrivés à échéance. */
export async function listDueDeletions(now: Date = new Date()): Promise<ScheduledDeletion[]> {
  const rows = await db
    .select()
    .from(scheduledAccountDeletions)
    .where(
      and(
        eq(scheduledAccountDeletions.status, 'SCHEDULED'),
        lte(scheduledAccountDeletions.scheduledAt, now),
      ),
    );
  return rows.map(toScheduled);
}

/**
 * Suppressions en retard — anomalie du §21.
 *
 * « Suppression de données non exécutée à l'échéance » figure parmi les
 * anomalies à détecter. Sans cette requête, un travail planifié en panne
 * passerait inaperçu jusqu'à ce qu'on cherche à justifier la suppression.
 */
export async function listOverdueDeletions(
  now: Date = new Date(),
  toleranceHours = 24,
): Promise<ScheduledDeletion[]> {
  const threshold = new Date(now.getTime() - toleranceHours * 3600 * 1000);
  const rows = await db
    .select()
    .from(scheduledAccountDeletions)
    .where(
      and(
        eq(scheduledAccountDeletions.status, 'SCHEDULED'),
        lte(scheduledAccountDeletions.scheduledAt, threshold),
      ),
    );
  return rows.map(toScheduled);
}

/* ── Exécution ─────────────────────────────────────────────────────────── */

export interface ExecutionResult {
  status: 'executed' | 'skipped' | 'failed';
  reason?: string;
  /** Preuves conservées, dénombrées après suppression. */
  preserved?: { legalAcceptances: number };
}

/**
 * Exécute une suppression arrivée à échéance.
 *
 * Trois refus explicites, et c'est volontaire :
 *
 *   • compte partagé — supprimer le titulaire d'un compte Duo emporterait les
 *     données du second membre, qui n'a rien demandé. Le cas doit être traité
 *     par un transfert de propriété, pas par une cascade ;
 *   • compte à rebours annulé entre le balayage et l'exécution ;
 *   • disparition d'une preuve à conserver, détectée après coup.
 *
 * @param dryRun simule sans rien écrire. Le premier passage en production
 *   devrait toujours se faire ainsi.
 */
export async function executeScheduledDeletion(
  scheduleId: number,
  options: { dryRun?: boolean; now?: Date } = {},
): Promise<ExecutionResult> {
  const now = options.now ?? new Date();

  const [schedule] = await db
    .select()
    .from(scheduledAccountDeletions)
    .where(eq(scheduledAccountDeletions.id, scheduleId))
    .limit(1);

  if (!schedule) return { status: 'skipped', reason: 'SCHEDULE_NOT_FOUND' };
  if (schedule.status !== 'SCHEDULED') {
    return { status: 'skipped', reason: `STATUS_${schedule.status}` };
  }

  const [account] = await db
    .select({ id: accounts.id, ownerUserId: accounts.ownerUserId })
    .from(accounts)
    .where(eq(accounts.id, schedule.accountId))
    .limit(1);

  if (!account) {
    // Le compte a déjà disparu par un autre chemin : rien à faire, mais le
    // compte à rebours doit être clos pour ne pas ressortir à chaque balayage.
    await db
      .update(scheduledAccountDeletions)
      .set({ status: 'EXECUTED', executedAt: now, updatedAt: now })
      .where(eq(scheduledAccountDeletions.id, scheduleId));
    return { status: 'executed', reason: 'ACCOUNT_ALREADY_GONE' };
  }

  // Compte partagé : refus net plutôt qu'une suppression collatérale.
  const otherMembers = await db
    .select({ id: accountMemberships.id })
    .from(accountMemberships)
    .where(
      and(
        eq(accountMemberships.accountId, account.id),
        or(
          isNull(accountMemberships.userId),
          sql`${accountMemberships.userId} <> ${account.ownerUserId}`,
        ),
      ),
    );

  if (otherMembers.length > 0) {
    const reason =
      `Compte partagé (${otherMembers.length} autre(s) membre(s)) : suppression refusée. ` +
      'Transférez la propriété ou retirez les membres avant de supprimer.';
    if (!options.dryRun) {
      await db
        .update(scheduledAccountDeletions)
        .set({ status: 'FAILED', failureReason: reason, updatedAt: now })
        .where(eq(scheduledAccountDeletions.id, scheduleId));
    }
    console.error(`[deletion] compte ${account.id} : ${reason}`);
    return { status: 'failed', reason };
  }

  if (options.dryRun) {
    return { status: 'skipped', reason: 'DRY_RUN' };
  }

  try {
    const preserved = await db.transaction(async (tx) => {
      // Preuves à conserver, dénombrées AVANT la cascade.
      const before = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(legalAcceptances)
        .where(eq(legalAcceptances.userId, account.ownerUserId));
      const expectedAcceptances = before[0]?.n ?? 0;

      // Pseudonymisation préalable (CDC CGVU §14.2) : la preuve survit, mais
      // cesse d'être nominative. La faire AVANT la cascade évite de dépendre
      // de l'ordre dans lequel PostgreSQL applique `SET NULL`.
      await tx
        .update(legalAcceptances)
        .set({ userId: null, ipAddress: null, userAgent: null })
        .where(eq(legalAcceptances.userId, account.ownerUserId));

      // La cascade fait le reste : quarante tables suivent `accounts`, et
      // `accounts` suit `users`. Le schéma est la seule liste qui vaille.
      await tx.delete(users).where(eq(users.id, account.ownerUserId));

      // Garde-fou : les preuves pseudonymisées doivent toujours être là.
      const after = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(legalAcceptances)
        .where(isNull(legalAcceptances.userId));

      if ((after[0]?.n ?? 0) < expectedAcceptances) {
        throw new DeletionError(
          'PROOF_LOST',
          `${expectedAcceptances} preuve(s) d'acceptation attendue(s), ` +
          `${after[0]?.n ?? 0} trouvée(s) après suppression. Transaction annulée.`,
        );
      }

      return { legalAcceptances: expectedAcceptances };
    });

    // Le compte à rebours a été emporté par la cascade : on le réécrit hors
    // transaction, pour garder la trace exigée par le §17.
    await db.insert(scheduledAccountDeletions).values({
      accountId: schedule.accountId,
      userId: null,
      reason: schedule.reason,
      confirmedAt: schedule.confirmedAt,
      scheduledAt: schedule.scheduledAt,
      status: 'EXECUTED',
      executedAt: now,
      createdAt: schedule.createdAt,
      updatedAt: now,
    }).onConflictDoNothing();

    console.info(
      `[deletion] compte ${account.id} supprimé — ` +
      `${preserved.legalAcceptances} preuve(s) d'acceptation conservée(s).`,
    );
    return { status: 'executed', preserved };
  } catch (e) {
    const reason = (e as Error).message;
    await db
      .update(scheduledAccountDeletions)
      .set({ status: 'FAILED', failureReason: reason, updatedAt: now })
      .where(eq(scheduledAccountDeletions.id, scheduleId));
    console.error(`[deletion] compte ${account.id} : échec — ${reason}`);
    return { status: 'failed', reason };
  }
}
