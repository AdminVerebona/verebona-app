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
  assetFiles,
  assetTransmissions,
  invoices,
  legalAcceptances,
  pendingBlobDeletions,
  scheduledAccountDeletions,
  supplierReviewItems,
  suppliers,
  users,
  withdrawalRequests,
} from '@/db/schema';
import { and, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import {
  onDeletionCancelled,
  onDeletionExecuted,
  onDeletionFailed,
  onDeletionScheduled,
} from '@/services/gdpr/system-requests';

/** Délai avant suppression effective, en jours (§13.3). */
export const DELETION_DELAY_DAYS = 30;

/** UNPAID : J+90 d'un impayé non régularisé (Centre d'aide GAP-06, migration 0182). */
export type DeletionReason = 'WITHDRAWAL' | 'VOLUNTARY' | 'TRIAL_ABANDONED' | 'ADMIN' | 'UNPAID';

/**
 * Qui a engagé la suppression (CDC Back-Office ACC-A14, migration 0170).
 *
 * Le BO déclenche la suppression par ce même workflow unique : « seule
 * l'origine diffère ». Elle est déduite du motif quand l'appelant ne la
 * précise pas, pour que les appelants existants (rétractation) restent
 * inchangés.
 */
export type DeletionOrigin = 'user' | 'system' | 'admin';

export function defaultOriginFor(reason: DeletionReason): DeletionOrigin {
  if (reason === 'ADMIN') return 'admin';
  if (reason === 'TRIAL_ABANDONED' || reason === 'UNPAID') return 'system';
  return 'user';
}
export type DeletionStatus = 'SCHEDULED' | 'CANCELLED' | 'EXECUTED' | 'FAILED';

/**
 * Portée d'une suppression (migration 0206).
 *
 *   - `account` : le compte ET tous ses utilisateurs (titulaire + second
 *     utilisateur) — rétractation, impayé J+90, back-office, essai abandonné.
 *     Comportement historique, inchangé.
 *   - `user` : suppression VOLONTAIRE demandée par un utilisateur pour
 *     lui-même. Seuls l'utilisateur demandeur et les comptes dont il est
 *     titulaire sont supprimés ; un second utilisateur n'est jamais emporté
 *     par la décision d'un autre (voir `executeScheduledDeletion`).
 */
export type DeletionScope = 'account' | 'user';

export function scopeFor(reason: DeletionReason): DeletionScope {
  return reason === 'VOLUNTARY' ? 'user' : 'account';
}

export interface ScheduledDeletion {
  id: number;
  accountId: number;
  userId: number | null;
  reason: DeletionReason;
  origin: DeletionOrigin;
  scope: DeletionScope;
  confirmedAt: Date;
  scheduledAt: Date;
  status: DeletionStatus;
  reminderJ7SentAt: Date | null;
  reminderJ1SentAt: Date | null;
  /** Tentatives d'exécution en échec (reprise de la portée user, 0206). */
  attemptCount: number;
  /** Anomalie d'administration déjà signalée (0206). */
  anomalyReportedAt: Date | null;
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
  /** Défaut : déduite du motif (`defaultOriginFor`). */
  origin?: DeletionOrigin;
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

  const scope = scopeFor(input.reason);
  const inserted = await db
    .insert(scheduledAccountDeletions)
    .values({
      accountId: input.accountId,
      userId: input.userId,
      reason: input.reason,
      origin: input.origin ?? defaultOriginFor(input.reason),
      scope,
      confirmedAt,
      scheduledAt,
      status: 'SCHEDULED',
      createdAt: confirmedAt,
      updatedAt: confirmedAt,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length > 0) {
    const created = toScheduled(inserted[0]);
    // Registre RGPD (CDC BO GDP-007, GDP-008) : best-effort, ne lève jamais.
    await onDeletionScheduled(created);
    return created;
  }

  // Index uniques (0206) : un compte à rebours actif par compte (portée
  // `account`), un par utilisateur (portée `user`).
  const existing = scope === 'user'
    ? await getActiveUserSchedule(input.userId)
    : await getActiveSchedule(input.accountId);
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
    origin: (row.origin ?? defaultOriginFor(row.reason as DeletionReason)) as DeletionOrigin,
    scope: (row.scope === 'user' ? 'user' : 'account') as DeletionScope,
    confirmedAt: row.confirmedAt,
    scheduledAt: row.scheduledAt,
    status: row.status as DeletionStatus,
    reminderJ7SentAt: row.reminderJ7SentAt ?? null,
    reminderJ1SentAt: row.reminderJ1SentAt ?? null,
    attemptCount: row.attemptCount ?? 0,
    anomalyReportedAt: row.anomalyReportedAt ?? null,
  };
}

/**
 * Compte à rebours en cours pour un compte (portée `account`), s'il y en a un.
 *
 * La portée `user` (suppression volontaire d'un utilisateur) est exclue : elle
 * ne supprime pas le compte en tant que tel pour ses autres membres, et ne
 * doit ni être annulée par une souscription du titulaire, ni masquer la
 * planification d'une rétractation ou d'un impayé.
 */
export async function getActiveSchedule(accountId: number): Promise<ScheduledDeletion | null> {
  const [row] = await db
    .select()
    .from(scheduledAccountDeletions)
    .where(
      and(
        eq(scheduledAccountDeletions.accountId, accountId),
        eq(scheduledAccountDeletions.status, 'SCHEDULED'),
        eq(scheduledAccountDeletions.scope, 'account'),
      ),
    )
    .limit(1);
  return row ? toScheduled(row) : null;
}

/** Suppression volontaire en cours pour un utilisateur (portée `user`). */
export async function getActiveUserSchedule(userId: number): Promise<ScheduledDeletion | null> {
  const [row] = await db
    .select()
    .from(scheduledAccountDeletions)
    .where(
      and(
        eq(scheduledAccountDeletions.userId, userId),
        eq(scheduledAccountDeletions.status, 'SCHEDULED'),
        eq(scheduledAccountDeletions.scope, 'user'),
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
        eq(scheduledAccountDeletions.scope, 'account'),
      ),
    )
    .returning();

  if (row) {
    await onDeletionCancelled(row.id, reason);
    console.info(
      `[deletion] compte ${accountId} : suppression annulée (${reason}), ` +
      `échéance ${row.scheduledAt.toISOString()} abandonnée.`,
    );
  }
  return row ? toScheduled(row) : null;
}

/**
 * Annule la suppression VOLONTAIRE d'un utilisateur (portée `user`) et lui
 * rend un usage normal (`users.status` : PENDING_DELETION → ACTIVE), dans une
 * transaction : le compte à rebours et le statut ne peuvent pas diverger.
 *
 * Idempotente : sans compte à rebours actif, seul un statut resté à
 * PENDING_DELETION (écriture interrompue) est réparé.
 */
export async function cancelUserDeletion(
  userId: number,
  reason: string,
  now: Date = new Date(),
): Promise<ScheduledDeletion | null> {
  // Verrous dans le MÊME ordre que l'exécution (compte à rebours, puis
  // utilisateur) : une annulation et un balayage concurrents se sérialisent,
  // sans interblocage. Une exécution réservée (`processing_started_at`) ne
  // peut plus être annulée : Stripe a pu être résilié, la suppression est en
  // cours.
  const row = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: scheduledAccountDeletions.id, processingStartedAt: scheduledAccountDeletions.processingStartedAt })
      .from(scheduledAccountDeletions)
      .where(
        and(
          eq(scheduledAccountDeletions.userId, userId),
          eq(scheduledAccountDeletions.status, 'SCHEDULED'),
          eq(scheduledAccountDeletions.scope, 'user'),
        ),
      )
      .for('update');
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    if (locked && isClaimActive(locked.processingStartedAt, now)) {
      throw new DeletionError('DELETION_IN_PROGRESS', 'La suppression du compte est en cours d’exécution.');
    }

    const [cancelled] = locked
      ? await tx
          .update(scheduledAccountDeletions)
          .set({ status: 'CANCELLED', cancelledAt: now, cancellationReason: reason, updatedAt: now })
          .where(and(eq(scheduledAccountDeletions.id, locked.id), eq(scheduledAccountDeletions.status, 'SCHEDULED')))
          .returning()
      : [];
    await tx
      .update(users)
      .set({ status: 'ACTIVE', updatedAt: now })
      .where(and(eq(users.id, userId), eq(users.status, 'PENDING_DELETION')));
    return cancelled ?? null;
  });

  if (row) {
    await onDeletionCancelled(row.id, reason);
    console.info(`[deletion] utilisateur ${userId} : suppression volontaire annulée (${reason}).`);
  }
  return row ? toScheduled(row) : null;
}

/** Durée de validité d'une réservation d'exécution (processus interrompu au-delà). */
export const EXECUTION_CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

export function isClaimActive(processingStartedAt: Date | null | undefined, now: Date): boolean {
  return !!processingStartedAt && now.getTime() - processingStartedAt.getTime() < EXECUTION_CLAIM_TTL_MS;
}

/** Délai avant la tentative suivante d'une suppression volontaire en échec : 1 j, 2 j, 4 j, puis 7 j. */
export function retryDelayMs(attempt: number): number {
  const days = Math.min(7, 2 ** Math.max(0, attempt - 1));
  return days * 24 * 60 * 60 * 1000;
}

export type ClaimResult =
  | { ok: true; user: { id: number; email: string; status: string } | null }
  | { ok: false; reason: 'NOT_SCHEDULED' | 'IN_PROGRESS' | 'USER_NOT_CLOSED'; userStatus?: string };

/**
 * Réserve l'exécution d'une suppression volontaire arrivée à échéance, sous
 * verrou (compte à rebours puis utilisateur — même ordre que l'annulation) :
 * encore programmée, pas déjà réservée, utilisateur toujours clôturé. À
 * partir de là, l'annulation est refusée ; les étapes irréversibles
 * (résiliation Stripe, fin du Duo) ne commencent qu'après cette réservation.
 */
export async function claimUserDeletion(scheduleId: number, now: Date = new Date()): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        status: scheduledAccountDeletions.status,
        userId: scheduledAccountDeletions.userId,
        processingStartedAt: scheduledAccountDeletions.processingStartedAt,
      })
      .from(scheduledAccountDeletions)
      .where(eq(scheduledAccountDeletions.id, scheduleId))
      .for('update');
    if (!row || row.status !== 'SCHEDULED') return { ok: false as const, reason: 'NOT_SCHEDULED' as const };
    if (isClaimActive(row.processingStartedAt, now)) return { ok: false as const, reason: 'IN_PROGRESS' as const };

    let user: { id: number; email: string; status: string } | null = null;
    if (row.userId != null) {
      [user] = await tx
        .select({ id: users.id, email: users.email, status: users.status })
        .from(users)
        .where(eq(users.id, row.userId))
        .for('update');
      user ??= null;
      if (user && user.status !== 'PENDING_DELETION') {
        return { ok: false as const, reason: 'USER_NOT_CLOSED' as const, userStatus: user.status };
      }
    }
    await tx
      .update(scheduledAccountDeletions)
      .set({ processingStartedAt: now, updatedAt: now })
      .where(eq(scheduledAccountDeletions.id, scheduleId));
    return { ok: true as const, user };
  });
}

/** Rend une réservation (étape préalable en échec, ex. Stripe injoignable). */
export async function releaseUserDeletionClaim(scheduleId: number, now: Date = new Date()): Promise<void> {
  await db
    .update(scheduledAccountDeletions)
    .set({ processingStartedAt: null, updatedAt: now })
    .where(and(eq(scheduledAccountDeletions.id, scheduleId), eq(scheduledAccountDeletions.status, 'SCHEDULED')));
}

/** État terminal FAILED, avec motif (ex. utilisateur non clôturé). */
export async function markDeletionFailed(scheduleId: number, reason: string, now: Date = new Date()): Promise<void> {
  const rows = await db
    .update(scheduledAccountDeletions)
    .set({ status: 'FAILED', failureReason: reason, processingStartedAt: null, updatedAt: now })
    .where(and(eq(scheduledAccountDeletions.id, scheduleId), eq(scheduledAccountDeletions.status, 'SCHEDULED')))
    .returning({ id: scheduledAccountDeletions.id });
  if (rows.length > 0) await onDeletionFailed(scheduleId, reason);
}

/** Anomalie d'administration signalée : ne plus la signaler pour ce compte à rebours. */
export async function markAnomalyReported(scheduleId: number, now: Date = new Date()): Promise<void> {
  await db
    .update(scheduledAccountDeletions)
    .set({ anomalyReportedAt: now })
    .where(and(eq(scheduledAccountDeletions.id, scheduleId), isNull(scheduledAccountDeletions.anomalyReportedAt)));
}

/** Dernier compte à rebours volontaire d'un utilisateur, quel que soit son état. */
export async function getLatestUserSchedule(userId: number): Promise<ScheduledDeletion | null> {
  const [row] = await db
    .select()
    .from(scheduledAccountDeletions)
    .where(and(eq(scheduledAccountDeletions.userId, userId), eq(scheduledAccountDeletions.scope, 'user')))
    .orderBy(desc(scheduledAccountDeletions.id))
    .limit(1);
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
        // Reprise après échec : pas avant la tentative suivante.
        or(isNull(scheduledAccountDeletions.nextAttemptAt), lte(scheduledAccountDeletions.nextAttemptAt, now)),
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
  preserved?: { legalAcceptances: number; withdrawalRequests: number; invoices?: number };
  /** Périmètre supprimé. */
  deleted?: { users: number[]; accounts: number[]; files: number };
  /** Échec d'une suppression volontaire : prochain essai. */
  retryAt?: Date;
}

/** Tables de preuves qui survivent (pseudonymisées) — exclues du contrôle d'orphelins. */
const SURVIVING_TABLES = new Set([
  'legal_acceptances', 'withdrawal_requests', 'withdrawal_events', 'scheduled_account_deletions',
  'pending_blob_deletions',
  // Registre RGPD : preuve du traitement, détaché par ON DELETE SET NULL
  // (références conservées dans subject_*_ref, migration 0174).
  'gdpr_requests',
  // Factures : pièces comptables conservées, détachées (migration 0206).
  'invoices',
]);
const ACCOUNT_COLUMNS = ['account_id', 'owner_account_id'];
const USER_COLUMNS = ['user_id', 'owner_user_id', 'billing_owner_user_id', 'initiator_user_id', 'recipient_user_id', 'created_by_user_id'];

/**
 * Exécute une suppression arrivée à échéance.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * COMPTE DUO : TOUT LE PÉRIMÈTRE, LES DEUX UTILISATEURS
 *
 * L'exécution refusait tout compte comptant un autre membre — donc tout
 * compte Duo, qui ne pouvait jamais être supprimé. Dans le modèle Duo,
 * l'utilisateur secondaire est invité sur le compte du titulaire et ne peut
 * appartenir à aucun autre : à l'échéance, le compte, ses données, ses
 * adhésions, le titulaire ET l'utilisateur invité sont supprimés. Pas de
 * transfert de propriété, pas d'utilisateur conservé.
 *
 * Seule reste refusée une suppression COLLATÉRALE : si un des utilisateurs
 * possède ou partage un autre compte avec des personnes hors du périmètre
 * (incohérence du modèle), rien n'est supprimé et l'anomalie est tracée.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Ordre, dans une seule transaction :
 *   1. périmètre : utilisateurs (titulaire + membres) et comptes qu'ils
 *      possèdent ;
 *   2. fichiers du stockage mis en file de purge (`pending_blob_deletions`,
 *      cron purge-blobs) — sans quoi la cascade effacerait les références
 *      et laisserait les objets S3 orphelins ;
 *   3. preuves à conserver : acceptations des CGVU pseudonymisées ;
 *      demandes de rétractation conservées telles quelles (déclaration
 *      figée, §7.4), détachées par la cascade ;
 *   4. lignes des tables sans cascade (fournisseurs, revues fournisseurs,
 *      transmissions de biens) ;
 *   5. suppression des utilisateurs : la cascade du schéma emporte comptes,
 *      données métier, adhésions, compte Duo ;
 *   6. contrôles : preuves toujours présentes, aucune donnée orpheline
 *      rattachée aux comptes ou utilisateurs supprimés — sinon annulation.
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

  // 1. Périmètre, selon la portée (migration 0206).
  const scope: DeletionScope = schedule.scope === 'user' ? 'user' : 'account';
  const perimeter = scope === 'user'
    ? await resolveUserPerimeter(schedule.userId)
    : await resolveAccountPerimeter(schedule.accountId);

  if (perimeter.kind === 'gone') {
    // Le compte (ou l'utilisateur) a déjà disparu par un autre chemin : rien
    // à faire, mais le compte à rebours doit être clos pour ne pas ressortir
    // à chaque balayage.
    if (!options.dryRun) {
      await db
        .update(scheduledAccountDeletions)
        .set({ status: 'EXECUTED', executedAt: now, updatedAt: now })
        .where(and(eq(scheduledAccountDeletions.id, scheduleId), eq(scheduledAccountDeletions.status, 'SCHEDULED')));
      await onDeletionExecuted(scheduleId, now);
    }
    return { status: options.dryRun ? 'skipped' : 'executed', reason: perimeter.reason };
  }

  if (perimeter.kind === 'refused') {
    const reason = perimeter.reason;
    if (!options.dryRun) {
      await db
        .update(scheduledAccountDeletions)
        .set({ status: 'FAILED', failureReason: reason, updatedAt: now })
        .where(and(eq(scheduledAccountDeletions.id, scheduleId), eq(scheduledAccountDeletions.status, 'SCHEDULED')));
      await onDeletionFailed(scheduleId, reason);
    }
    console.error(`[deletion] compte ${schedule.accountId} : ${reason}`);
    return { status: 'failed', reason };
  }

  const { userIds, accountIds } = perimeter;
  const label = scope === 'user'
    ? `utilisateur ${userIds.join(', ')}`
    : `compte ${schedule.accountId}`;

  if (options.dryRun) {
    return { status: 'skipped', reason: 'DRY_RUN', deleted: { users: userIds, accounts: accountIds, files: 0 } };
  }

  try {
    const outcome = await db.transaction(async (tx) => {
      // 0. Verrou du compte à rebours, puis de l'utilisateur (portée user) —
      //    même ordre que l'annulation (`cancelUserDeletion`) : une
      //    annulation concurrente attend la fin de cette transaction, ou
      //    l'emporte et l'exécution s'arrête ici, sans rien supprimer.
      const [locked] = await tx
        .select({ status: scheduledAccountDeletions.status })
        .from(scheduledAccountDeletions)
        .where(eq(scheduledAccountDeletions.id, scheduleId))
        .for('update');
      if (!locked || locked.status !== 'SCHEDULED') {
        throw new SkipExecution(`STATUS_${locked?.status ?? 'MISSING'}`);
      }
      if (scope === 'user') {
        const [u] = await tx
          .select({ status: users.status })
          .from(users)
          .where(eq(users.id, userIds[0]))
          .for('update');
        if (!u) throw new SkipExecution('USER_ALREADY_GONE');
        if (u.status !== 'PENDING_DELETION') throw new SkipExecution(`USER_NOT_CLOSED (statut ${u.status})`);
      }

      // 2. Objets du stockage : mis en file de purge AVANT que la cascade
      //    n'efface leurs références.
      const files = await tx
        .select({ id: assetFiles.id, s3Key: assetFiles.s3Key })
        .from(assetFiles)
        .where(and(inArray(assetFiles.accountId, accountIds), isNotNull(assetFiles.s3Key)));
      if (files.length > 0) {
        await tx.insert(pendingBlobDeletions).values(
          files.map((f) => ({ fileId: null, storagePath: f.s3Key as string, scheduledFor: now, createdAt: now })),
        );
      }
      // Archives « Mes données » (export RGPD, migration 0174) : même file de
      // purge, la cascade effaçant `gdpr_exports`.
      // Garde : une base où la 0174 manque ne doit pas faire échouer la suppression.
      const asRows = <T,>(res: unknown): T[] =>
        Array.isArray(res) ? (res as T[]) : ((res as { rows?: T[] }).rows ?? []);
      const [reg] = asRows<{ t: string | null }>(await tx.execute(sql`SELECT to_regclass('gdpr_exports')::text AS t`));
      const archiveRows = reg?.t
        ? asRows<{ s3_key: string }>(await tx.execute(sql`
            SELECT s3_key FROM gdpr_exports
             WHERE s3_key IS NOT NULL
               AND user_id IN (${sql.join(userIds.map((u) => sql`${u}`), sql`, `)})
          `))
        : [];
      if (archiveRows.length > 0) {
        await tx.insert(pendingBlobDeletions).values(
          archiveRows.map((a) => ({ fileId: null, storagePath: a.s3_key, scheduledFor: now, createdAt: now })),
        );
      }

      // 3. Preuves à conserver, dénombrées AVANT la cascade, puis
      //    pseudonymisées (CDC CGVU §14.2) : elles survivent sans être
      //    nominatives. Faites AVANT la cascade pour ne pas dépendre de
      //    l'ordre d'application des `SET NULL`.
      const [acc] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(legalAcceptances)
        .where(inArray(legalAcceptances.userId, userIds));
      const expectedAcceptances = acc?.n ?? 0;
      await tx
        .update(legalAcceptances)
        .set({ userId: null, ipAddress: null, userAgent: null })
        .where(inArray(legalAcceptances.userId, userIds));

      // Demandes de rétractation : preuve d'un acte juridique, conservée
      // telle quelle — la déclaration est figée en base (trigger
      // withdrawal_requests_guard, CDC rétractation §7.4). Seuls ses liens
      // vers l'utilisateur et le compte tombent à NULL par la cascade.
      const withdrawals = await tx
        .select({ id: withdrawalRequests.id })
        .from(withdrawalRequests)
        .where(or(inArray(withdrawalRequests.userId, userIds), inArray(withdrawalRequests.accountId, accountIds)));

      // Factures (registre local des factures Stripe) : pièces comptables à
      // conserver 10 ans (art. L123-22 C. com.). Détachées du compte et de
      // l'utilisateur, jamais effacées (migration 0206) ; la facture légale
      // elle-même reste chez Stripe, client Stripe compris.
      const invoiceRows = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(or(inArray(invoices.userId, userIds), inArray(invoices.accountId, accountIds)));
      if (invoiceRows.length > 0) {
        // Chaque lien n'est détaché que s'il vise ce qui est supprimé : une
        // facture d'un compte conservé (portée user) garde son compte.
        await tx.update(invoices).set({ userId: null, updatedAt: now }).where(inArray(invoices.userId, userIds));
        await tx.update(invoices).set({ accountId: null, updatedAt: now }).where(inArray(invoices.accountId, accountIds));
      }

      // Portée `user` (suppression volontaire) : l'utilisateur est détaché
      // des espaces partagés dont il n'est pas titulaire, et ce qu'il y a
      // créé reste au titulaire de ces espaces.
      if (scope === 'user') {
        await detachFromSharedAccounts(tx, userIds[0], accountIds);
      }

      // 4. Tables sans cascade vers les comptes / utilisateurs : sans ces
      //    suppressions explicites, la cascade échouerait (clé étrangère).
      await tx.delete(supplierReviewItems).where(inArray(supplierReviewItems.accountId, accountIds));
      await tx.delete(suppliers).where(inArray(suppliers.accountId, accountIds));
      await tx.delete(assetTransmissions).where(
        or(inArray(assetTransmissions.initiatorUserId, userIds), inArray(assetTransmissions.recipientUserId, userIds)),
      );

      // 5. La cascade fait le reste : comptes, données métier, adhésions,
      //    compte Duo, sessions… Le schéma est la seule liste qui vaille.
      await tx.delete(users).where(inArray(users.id, userIds));

      // 6a. Les preuves pseudonymisées doivent toujours être là.
      const [after] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(legalAcceptances)
        .where(isNull(legalAcceptances.userId));
      if ((after?.n ?? 0) < expectedAcceptances) {
        throw new DeletionError(
          'PROOF_LOST',
          `${expectedAcceptances} preuve(s) d'acceptation attendue(s), ` +
          `${after?.n ?? 0} trouvée(s) après suppression. Transaction annulée.`,
        );
      }
      if (invoiceRows.length > 0) {
        const [kept] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(invoices)
          .where(inArray(invoices.id, invoiceRows.map((i) => i.id)));
        if ((kept?.n ?? 0) < invoiceRows.length) {
          throw new DeletionError(
            'PROOF_LOST',
            `${invoiceRows.length} facture(s) à conserver, ${kept?.n ?? 0} trouvée(s) après suppression. Transaction annulée.`,
          );
        }
      }

      // 6b. Aucune donnée orpheline : toute colonne « compte » ou
      //     « utilisateur » du schéma qui pointe encore vers le périmètre
      //     supprimé — tables sans clé étrangère (jetons révoqués, traces
      //     techniques…) — est purgée, puis le contrôle doit revenir vide.
      const residual = await findOrphans(tx, accountIds, userIds);
      for (const o of residual) {
        const ids = ACCOUNT_COLUMNS.includes(o.column) ? accountIds : userIds;
        await tx.execute(sql`
          DELETE FROM ${sql.identifier(o.table)}
           WHERE ${sql.identifier(o.column)} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
        `);
      }
      const orphans = await findOrphans(tx, accountIds, userIds);
      if (orphans.length > 0) {
        throw new DeletionError(
          'ORPHANS_LEFT',
          `Données orphelines après suppression : ${orphans.map((o) => `${o.table}.${o.column}=${o.count}`).join(', ')}. Transaction annulée.`,
        );
      }

      // 7. Trace EXÉCUTÉE dans la même transaction, conditionnée à l'état
      //    programmé : jamais d'« exécutée » sur un compte à rebours annulé.
      //    Le compte à rebours survit à la cascade (plus de clé étrangère vers
      //    le compte, migration 0144) : il porte la trace exigée par le §17.
      const done = await tx
        .update(scheduledAccountDeletions)
        .set({ status: 'EXECUTED', executedAt: now, userId: null, updatedAt: now })
        .where(and(eq(scheduledAccountDeletions.id, scheduleId), eq(scheduledAccountDeletions.status, 'SCHEDULED')))
        .returning({ id: scheduledAccountDeletions.id });
      if (done.length === 0) throw new SkipExecution('STATUS_CHANGED');

      return {
        preserved: {
          legalAcceptances: expectedAcceptances,
          withdrawalRequests: withdrawals.length,
          invoices: invoiceRows.length,
        },
        files: files.length,
        residual: residual.map((o) => `${o.table}.${o.column}`),
      };
    });

    // Demande RGPD Traitée ; e-mail et nom de compte figés effacés.
    await onDeletionExecuted(scheduleId, now);

    console.info(
      `[deletion] ${label} supprimé — utilisateurs ${userIds.join(', ')}, ` +
      `comptes ${accountIds.join(', ')}, ${outcome.files} fichier(s) en purge, ` +
      `${outcome.preserved.legalAcceptances} preuve(s) d'acceptation conservée(s)` +
      (outcome.residual.length ? ` ; résidus sans cascade purgés : ${outcome.residual.join(', ')}.` : '.'),
    );
    return {
      status: 'executed',
      preserved: outcome.preserved,
      deleted: { users: userIds, accounts: accountIds, files: outcome.files },
    };
  } catch (e) {
    if (e instanceof SkipExecution) {
      // Rien n'a été supprimé (transaction annulée) : état changé entre-temps.
      console.warn(`[deletion] ${label} : exécution abandonnée — ${e.message}`);
      return { status: 'skipped', reason: e.message };
    }
    // Erreur SQL enveloppée par drizzle (« Failed query: … ») : la cause
    // réelle est plus utile à l'administrateur que la requête.
    const cause = (e as { cause?: { message?: string } }).cause?.message;
    const reason = cause ? `${cause} — ${(e as Error).message.slice(0, 200)}` : (e as Error).message;
    if (scope === 'user') {
      // Suppression volontaire : l'utilisateur est clôturé et attend sa
      // suppression. Un échec technique n'est pas un état final — le compte à
      // rebours reste programmé, avec un nouvel essai différé (1 j, 2 j, 4 j,
      // puis 7 j) ; l'anomalie est signalée par le balayage.
      const [cur] = await db
        .select({ attempts: scheduledAccountDeletions.attemptCount })
        .from(scheduledAccountDeletions)
        .where(eq(scheduledAccountDeletions.id, scheduleId));
      const attempts = (cur?.attempts ?? 0) + 1;
      const retryAt = new Date(now.getTime() + retryDelayMs(attempts));
      await db
        .update(scheduledAccountDeletions)
        .set({
          failureReason: reason, attemptCount: attempts, nextAttemptAt: retryAt,
          processingStartedAt: null, updatedAt: now,
        })
        .where(and(eq(scheduledAccountDeletions.id, scheduleId), eq(scheduledAccountDeletions.status, 'SCHEDULED')));
      await onDeletionFailed(scheduleId, reason);
      console.error(`[deletion] ${label} : échec (tentative ${attempts}, nouvel essai le ${retryAt.toISOString()}) — ${reason}`);
      return { status: 'failed', reason, retryAt };
    }
    await db
      .update(scheduledAccountDeletions)
      .set({ status: 'FAILED', failureReason: reason, updatedAt: now })
      .where(and(eq(scheduledAccountDeletions.id, scheduleId), eq(scheduledAccountDeletions.status, 'SCHEDULED')));
    await onDeletionFailed(scheduleId, reason);
    console.error(`[deletion] ${label} : échec — ${reason}`);
    return { status: 'failed', reason };
  }
}

/** Exécution abandonnée sans effet (état changé entre-temps) : pas un échec. */
class SkipExecution extends Error {}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/* ── Périmètres ────────────────────────────────────────────────────────── */

type Perimeter =
  | { kind: 'ok'; userIds: number[]; accountIds: number[] }
  | { kind: 'gone'; reason: string }
  | { kind: 'refused'; reason: string };

/**
 * Portée `account` (comportement historique) : le compte, son titulaire et
 * tous les utilisateurs qui y sont rattachés, avec les comptes qu'ils
 * possèdent. Refus d'une suppression COLLATÉRALE (rattachement hors
 * périmètre).
 */
async function resolveAccountPerimeter(accountId: number): Promise<Perimeter> {
  const [account] = await db
    .select({ id: accounts.id, ownerUserId: accounts.ownerUserId })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) return { kind: 'gone', reason: 'ACCOUNT_ALREADY_GONE' };

  // Titulaire + tous les utilisateurs rattachés au compte.
  const memberRows = await db
    .select({ userId: accountMemberships.userId })
    .from(accountMemberships)
    .where(and(eq(accountMemberships.accountId, account.id), isNotNull(accountMemberships.userId)));
  const userIds = [...new Set([account.ownerUserId, ...memberRows.map((m) => m.userId as number)])];

  // Comptes que la cascade emportera (possédés par un utilisateur du périmètre).
  const ownedAccounts = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(inArray(accounts.ownerUserId, userIds));
  const accountIds = [...new Set([account.id, ...ownedAccounts.map((a) => a.id)])];

  // Suppression collatérale ? Un compte du périmètre partagé avec quelqu'un
  // hors périmètre, ou un utilisateur membre d'un compte hors périmètre.
  const outsiders = await db
    .select({ accountId: accountMemberships.accountId, userId: accountMemberships.userId })
    .from(accountMemberships)
    .where(
      or(
        and(inArray(accountMemberships.accountId, accountIds), isNotNull(accountMemberships.userId),
          sql`${accountMemberships.userId} NOT IN (${sql.join(userIds.map((u) => sql`${u}`), sql`, `)})`),
        and(inArray(accountMemberships.userId, userIds),
          sql`${accountMemberships.accountId} NOT IN (${sql.join(accountIds.map((a) => sql`${a}`), sql`, `)})`),
      ),
    );

  if (outsiders.length > 0) {
    return {
      kind: 'refused',
      reason:
        `Suppression collatérale refusée : ${outsiders.length} rattachement(s) hors du périmètre du compte ` +
        `(utilisateurs ${userIds.join(', ')}). Le modèle Duo interdit qu'un membre appartienne à un autre compte.`,
    };
  }
  return { kind: 'ok', userIds, accountIds };
}

/**
 * Portée `user` (suppression volontaire) : l'utilisateur demandeur et les
 * seuls comptes dont il est TITULAIRE.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INTERPRÉTATION RETENUE POUR LES ESPACES PARTAGÉS (Duo, compte partagé)
 *
 *   - Le demandeur est SECOND UTILISATEUR d'un espace dont il n'est pas
 *     titulaire : il en est détaché (adhésion supprimée) ; les biens,
 *     documents et échéances de cet espace RESTENT au titulaire, y compris
 *     ceux que le demandeur y avait créés (`detachFromSharedAccounts`). Ses
 *     données propres — son compte personnel, ce qu'il contient, son
 *     historique d'assistant, ses notifications — sont supprimées.
 *
 *   - Le demandeur est TITULAIRE : son compte et ce qu'il contient sont
 *     supprimés ; le second utilisateur n'est PAS supprimé. Il perd l'accès à
 *     l'espace (son adhésion disparaît avec le compte) et garde son propre
 *     compte et ses propres biens. La fin du Duo elle-même (déverrouillage
 *     des biens, offre du membre ramenée à la sienne) est appliquée avant
 *     l'exécution par le service de suppression volontaire, via le service
 *     de fin de Duo existant.
 *
 * Il n'y a donc jamais de refus « collatéral » ici : aucun autre utilisateur
 * n'est dans le périmètre.
 * ══════════════════════════════════════════════════════════════════════════
 */
async function resolveUserPerimeter(userId: number | null): Promise<Perimeter> {
  if (userId == null) return { kind: 'gone', reason: 'USER_ALREADY_GONE' };
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { kind: 'gone', reason: 'USER_ALREADY_GONE' };

  const owned = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.ownerUserId, userId));
  return { kind: 'ok', userIds: [userId], accountIds: owned.map((a) => a.id) };
}

/**
 * Contenus qu'un utilisateur a créés dans un espace dont il n'est pas
 * titulaire : transférés au titulaire de cet espace avant la cascade, qui
 * les emporterait sinon (clés `ON DELETE CASCADE` vers `users`). Liste
 * FERMÉE, volontairement : un transfert automatique « toute colonne
 * utilisateur » pourrait réattribuer une ligne personnelle (préférence,
 * jeton, conversation) — celles-là doivent être supprimées.
 */
const SHARED_CONTENT_BY_ACCOUNT: ReadonlyArray<readonly [table: string, column: string]> = [
  ['assets', 'user_id'],
  ['asset_files', 'user_id'],
  ['deadlines', 'user_id'],
  ['events', 'user_id'],
  ['calendar_additions', 'user_id'],
  ['document_versions', 'user_id'],
  ['export_generation', 'user_id'],
  ['suppliers', 'created_by_user_id'],
];
/** Contenus rattachés à un bien (sans colonne compte) : suivent le bien. */
const SHARED_CONTENT_BY_ASSET: ReadonlyArray<readonly [table: string, column: string]> = [
  ['documents', 'user_id'],
  ['asset_photos', 'user_id'],
];

async function detachFromSharedAccounts(tx: Tx, userId: number, ownAccountIds: number[]): Promise<void> {
  const own = ownAccountIds.length > 0
    ? sql`AND t.account_id NOT IN (${sql.join(ownAccountIds.map((a) => sql`${a}`), sql`, `)})`
    : sql``;

  for (const [table, column] of SHARED_CONTENT_BY_ACCOUNT) {
    await tx.execute(sql`
      UPDATE ${sql.identifier(table)} AS t
         SET ${sql.identifier(column)} = a.owner_user_id
        FROM accounts a
       WHERE t.account_id = a.id
         AND a.owner_user_id <> ${userId}
         AND t.${sql.identifier(column)} = ${userId}
         ${own}
    `);
  }
  // Après le transfert des biens : documents et photos suivent le bien.
  for (const [table, column] of SHARED_CONTENT_BY_ASSET) {
    await tx.execute(sql`
      UPDATE ${sql.identifier(table)} AS t
         SET ${sql.identifier(column)} = b.user_id
        FROM assets b
       WHERE t.asset_id = b.id
         AND b.user_id <> ${userId}
         AND t.${sql.identifier(column)} = ${userId}
    `);
  }
  // Clé sans action (NO ACTION) : la trace de résolution devient anonyme.
  await tx.execute(sql`
    UPDATE supplier_review_items SET resolved_by_user_id = NULL WHERE resolved_by_user_id = ${userId}
  `);
  // Journal des espaces partagés : l'auteur tombe à NULL par la cascade ;
  // l'adresse e-mail recopiée est pseudonymisée.
  await tx.execute(sql`
    UPDATE account_audit_log SET user_email = 'utilisateur supprimé' WHERE user_id = ${userId}
  `);
  await tx.execute(sql`
    UPDATE account_audit_log SET target_user_email = NULL WHERE target_user_id = ${userId}
  `);
  // Adhésions aux espaces partagés : détachement explicite (la cascade le
  // ferait aussi, mais l'intention doit se lire ici).
  await tx.delete(accountMemberships).where(eq(accountMemberships.userId, userId));
}

/**
 * Lignes restantes rattachées aux comptes / utilisateurs supprimés, sur toutes
 * les tables du schéma (hors tables de preuves pseudonymisées).
 */
async function findOrphans(
  tx: Tx,
  accountIds: number[],
  userIds: number[],
): Promise<Array<{ table: string; column: string; count: number }>> {
  const cols = await tx.execute(sql`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND column_name IN (${sql.join([...ACCOUNT_COLUMNS, ...USER_COLUMNS].map((c) => sql`${c}`), sql`, `)})
       AND data_type IN ('integer', 'bigint')
  `) as unknown as Array<{ table_name: string; column_name: string }>;
  const rows = Array.isArray(cols) ? cols : ((cols as unknown as { rows?: typeof cols }).rows ?? []);

  const found: Array<{ table: string; column: string; count: number }> = [];
  for (const { table_name: table, column_name: column } of rows) {
    if (SURVIVING_TABLES.has(table)) continue;
    const ids = ACCOUNT_COLUMNS.includes(column) ? accountIds : userIds;
    if (ids.length === 0) continue;
    const res = await tx.execute(sql`
      SELECT count(*)::int AS n FROM ${sql.identifier(table)}
       WHERE ${sql.identifier(column)} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    `) as unknown as Array<{ n: number }>;
    const r = Array.isArray(res) ? res : ((res as unknown as { rows?: typeof res }).rows ?? []);
    const n = Number(r[0]?.n ?? 0);
    if (n > 0) found.push({ table, column, count: n });
  }
  return found;
}
