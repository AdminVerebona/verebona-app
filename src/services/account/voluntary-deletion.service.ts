/**
 * Suppression VOLONTAIRE du compte par son utilisateur — différée de 30 jours.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉCISION PRODUIT
 *
 *   J0 — CLÔTURE, sur confirmation (texte « SUPPRIMER MON COMPTE » + mot de
 *   passe, mêmes conventions que le changement de mot de passe) :
 *     · le compte est clôturé : `users.status = 'PENDING_DELETION'`, toutes
 *       les sessions sont révoquées. Une reconnexion ne mène plus qu'à
 *       l'écran « Compte en cours de suppression » (annuler / exporter,
 *       `lib/auth/account-closure`) ;
 *     · l'abonnement ne se renouvelle plus : résiliation Stripe en FIN DE
 *       PÉRIODE (la période payée n'est ni remboursée ni écourtée — ce n'est
 *       pas une rétractation) ; un abonnement déjà en impayé est résilié
 *       immédiatement (il n'y a plus de service à régulariser) ;
 *     · tout partage cesse immédiatement (voir « Duo » ci-dessous) ;
 *     · un compte à rebours `scheduled_account_deletions` (motif VOLUNTARY,
 *       origine user, portée user) fixe la date J+30, figée ; il alimente le
 *       registre RGPD (demande système « effacement », GDP-007/008) ;
 *     · e-mail de confirmation avec la date et le lien vers l'écran
 *       d'annulation / d'export.
 *
 *   J0 → J+30 — ANNULATION possible à tout moment : l'accès normal est
 *   rétabli. Elle ne rétablit NI l'abonnement (aucune souscription n'est
 *   recréée d'office : l'abonnement résilié s'arrête à la fin de la période
 *   déjà payée, puis le compte revient à l'offre Standard / au mode
 *   restreint ; le renouvellement se réactive depuis Mon compte > Offres,
 *   portail de paiement) NI les partages (le second utilisateur Duo doit
 *   être invité à nouveau).
 *
 *   J-7 — e-mail de rappel.
 *
 *   J+30 — SUPPRESSION par le balayage quotidien (`runAccountDeletionSweep`,
 *   tâche interne `daily-account-deletion` et GET /api/cron/account-deletion
 *   /process) : abonnements Stripe encore actifs résiliés immédiatement,
 *   partages rompus, puis exécution par le workflow UNIQUE
 *   `executeScheduledDeletion` (portée user) : biens, documents, fichiers
 *   S3 (file de purge), échéances, historique de l'assistant, notifications,
 *   exports… Sont conservés, détachés et pseudonymisés : factures (10 ans),
 *   preuves d'acceptation des CGVU, demandes de rétractation, trace de la
 *   suppression et registre RGPD. Puis e-mail de confirmation finale.
 *
 * DUO (interprétation retenue, cohérente avec AID-DUO-005/006) :
 *   · le demandeur est SECOND UTILISATEUR : il quitte le Duo dès la clôture
 *     (service de sortie existant `leaveDuo`, membership LEFT, demandes en
 *     attente annulées, biens déverrouillés). Les biens du Duo restent au
 *     titulaire — y compris ceux que le demandeur y a créés (transfert au
 *     titulaire à l'exécution). Ses données personnelles suivent sa
 *     suppression ;
 *   · le demandeur est TITULAIRE : le Duo prend fin dès la clôture (service
 *     existant `endDuoSharing` : second utilisateur retiré, invitation
 *     annulée, demandes annulées, biens déverrouillés, offre du membre
 *     ramenée à la sienne). Le second utilisateur n'est jamais supprimé : il
 *     garde son propre compte et ses propres biens. Le compte du titulaire
 *     (donc l'espace partagé) est supprimé à J+30.
 *   Même règle pour les adhésions « compte partagé » (`account_memberships`).
 *
 * Le back-office VOIT ces demandes (registre RGPD, état et date prévue) mais
 * ne peut ni les annuler ni les modifier (CDC BO GDP-008, REC-GDP-05).
 * ══════════════════════════════════════════════════════════════════════════
 */
import bcrypt from 'bcrypt';
import type Stripe from 'stripe';
import { and, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import { db, revokeAllUserSessions } from '@/db';
import {
  accountMemberships,
  accountSubscriptions,
  accounts,
  duoAccounts,
  duoMemberships,
  scheduledAccountDeletions,
  users,
} from '@/db/schema';
import { getStripeServer } from '@/lib/stripe';
import { emit } from '@/lib/notifications';
import { emailService } from '@/lib/email/email-service';
import { serverCacheDelete } from '@/lib/server-cache';
import { sessionCutoffCacheKey } from '@/lib/auth/session-cutoff';
import { PENDING_DELETION_STATUS } from '@/lib/auth/account-closure';
import { endDuoSharing } from '@/lib/plan-enforcement';
import { endMembership, leaveDuo } from '@/services/duo/duo-exit.service';
import {
  DELETION_DELAY_DAYS,
  DeletionError,
  cancelUserDeletion,
  claimUserDeletion,
  executeScheduledDeletion,
  getActiveUserSchedule,
  getLatestUserSchedule,
  markAnomalyReported,
  markDeletionFailed,
  releaseUserDeletionClaim,
  type ClaimResult,
  listDueDeletions,
  listDueReminders,
  listOverdueDeletions,
  markReminderSent,
  scheduleDeletion,
  type ExecutionResult,
  type ScheduledDeletion,
} from '@/services/account/scheduled-deletion.service';

/** Texte à recopier, inchangé depuis le parcours historique (AID-ACCOUNT-006). */
export const ACCOUNT_DELETION_CONFIRMATION = 'SUPPRIMER MON COMPTE';

/** Délai de la suppression volontaire, en jours. */
export const VOLUNTARY_DELETION_DELAY_DAYS = DELETION_DELAY_DAYS;

/** Au-delà, la confirmation finale non envoyée est abandonnée et l'adresse effacée. */
export const FINAL_EMAIL_RETRY_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/* ── Erreurs ───────────────────────────────────────────────────────────── */

export type ClosureErrorCode =
  | 'INVALID_CONFIRMATION'
  | 'PASSWORD_REQUIRED'
  | 'INVALID_PASSWORD'
  | 'USER_NOT_FOUND'
  | 'USER_NOT_ACTIVE'
  | 'ADMIN_ACCOUNT'
  | 'NO_ACCOUNT'
  | 'BILLING_UNAVAILABLE';

export const CLOSURE_ERROR_MESSAGES: Record<ClosureErrorCode, string> = {
  INVALID_CONFIRMATION: `Pour confirmer, recopiez exactement « ${ACCOUNT_DELETION_CONFIRMATION} ».`,
  PASSWORD_REQUIRED: 'Saisissez votre mot de passe pour confirmer la suppression.',
  INVALID_PASSWORD: 'Le mot de passe est incorrect.',
  USER_NOT_FOUND: 'Utilisateur introuvable.',
  USER_NOT_ACTIVE: 'Ce compte ne peut pas être supprimé dans son état actuel. Contactez le support Verebona.',
  ADMIN_ACCOUNT:
    'Un compte administrateur ne peut pas être supprimé en libre-service : le rôle administrateur doit d’abord être retiré depuis le back-office.',
  NO_ACCOUNT: 'Aucun compte n’est rattaché à votre utilisateur. Contactez le support Verebona.',
  BILLING_UNAVAILABLE:
    'Votre abonnement n’a pas pu être résilié pour le moment : rien n’a été modifié. Réessayez dans quelques minutes.',
};

export const CLOSURE_ERROR_STATUS: Record<ClosureErrorCode, number> = {
  INVALID_CONFIRMATION: 400,
  PASSWORD_REQUIRED: 400,
  INVALID_PASSWORD: 401,
  USER_NOT_FOUND: 404,
  USER_NOT_ACTIVE: 409,
  ADMIN_ACCOUNT: 409,
  NO_ACCOUNT: 409,
  BILLING_UNAVAILABLE: 503,
};

/** Stripe injoignable ou non configuré alors qu'un abonnement est connu. */
export class BillingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingUnavailableError';
  }
}

/* ── Dépendances (injectables pour les tests) ──────────────────────────── */

export interface DeletionUser {
  id: number;
  email: string;
  firstName: string | null;
  passwordHash: string;
  status: string;
  role: string;
}

export type SharingRole = 'duo_owner' | 'duo_member' | null;

export interface VoluntaryDeletionDeps {
  loadUser(userId: number): Promise<DeletionUser | null>;
  verifyPassword(plain: string, hash: string): Promise<boolean>;
  /** Compte de rattachement de la demande : celui dont l'utilisateur est titulaire, sinon son adhésion active. */
  resolveAccount(userId: number): Promise<number | null>;
  getActiveUserSchedule(userId: number): Promise<ScheduledDeletion | null>;
  scheduleDeletion: typeof scheduleDeletion;
  cancelUserDeletion(userId: number, reason: string, now: Date): Promise<ScheduledDeletion | null>;
  /** users.status → PENDING_DELETION. */
  markClosed(userId: number, now: Date): Promise<void>;
  billing: {
    /** J0 : plus de renouvellement. Lève `BillingUnavailableError`. */
    stopRenewal(userId: number): Promise<string[]>;
    /** J+30 : résiliation immédiate de ce qui facture encore. Lève `BillingUnavailableError`. */
    cancelNow(userId: number): Promise<string[]>;
  };
  /** Rompt les partages (Duo, comptes partagés). Idempotent. */
  detachSharing(userId: number, now: Date): Promise<{ role: SharingRole; removedMemberships: number }>;
  revokeSessions(userId: number, reason: string): Promise<Date>;
  notify(input: {
    type: 'ACCOUNT_DELETION_SCHEDULED' | 'ACCOUNT_DELETION_REMINDER';
    userId: number;
    scheduleId: number;
    scheduledAt: Date;
    daysLeft?: number;
  }): Promise<void>;
  markInitialEmailSent(scheduleId: number, now: Date): Promise<void>;
  listDueReminders: typeof listDueReminders;
  markReminderSent: typeof markReminderSent;
  listDueDeletions: typeof listDueDeletions;
  listOverdueDeletions: typeof listOverdueDeletions;
  execute(scheduleId: number, options: { now: Date; dryRun?: boolean }): Promise<ExecutionResult>;
  /** Relève l'adresse de la confirmation finale avant exécution. */
  recordNotifyEmail(scheduleId: number, email: string): Promise<void>;
  listPendingFinalEmails(): Promise<Array<{ id: number; email: string; confirmedAt: Date; executedAt: Date | null }>>;
  getLatestUserSchedule(userId: number): Promise<ScheduledDeletion | null>;
  /** Réservation sous verrou avant les étapes irréversibles (voir `claimUserDeletion`). */
  claim(scheduleId: number, now: Date): Promise<ClaimResult>;
  releaseClaim(scheduleId: number, now: Date): Promise<void>;
  /** État terminal FAILED avec motif. */
  markFailed(scheduleId: number, reason: string, now: Date): Promise<void>;
  /** Anomalie de Supervision (consolidée par compte à rebours). */
  reportAnomaly(input: { scheduleId: number; accountId: number; title: string; reason: string }): Promise<void>;
  markAnomalyReported(scheduleId: number, now: Date): Promise<void>;
  sendFinalEmail(to: string, vars: { requestedAt: string; deletedAt: string }): Promise<boolean>;
  /** Envoi réussi, ou abandonné : l'adresse est effacée dans les deux cas. */
  closeFinalEmail(scheduleId: number, sent: boolean, now: Date): Promise<void>;
}

/* ── Règles pures ──────────────────────────────────────────────────────── */

export function formatDeletionDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long' }).format(date);
}

/** Jours restants avant la suppression (arrondi supérieur, jamais négatif). */
export function daysUntil(scheduledAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((scheduledAt.getTime() - now.getTime()) / DAY_MS));
}

export interface DeletionStatusView {
  /**
   * `scheduled` : suppression programmée ; `closed` : compte clôturé SANS
   * compte à rebours actif (exécution en échec, en cours ou état incohérent) —
   * l'écran « Compte en cours de suppression » reste affiché et l'annulation
   * possible, jamais de renvoi vers l'accueil (qui renverrait ici en boucle).
   */
  status: 'none' | 'scheduled' | 'closed';
  confirmedAt: string | null;
  scheduledAt: string | null;
  daysLeft: number | null;
}

export function toStatusView(schedule: ScheduledDeletion | null, now: Date): DeletionStatusView {
  if (!schedule) return { status: 'none', confirmedAt: null, scheduledAt: null, daysLeft: null };
  return {
    status: 'scheduled',
    confirmedAt: schedule.confirmedAt.toISOString(),
    scheduledAt: schedule.scheduledAt.toISOString(),
    daysLeft: daysUntil(schedule.scheduledAt, now),
  };
}

/* ── Clôture (J0) ──────────────────────────────────────────────────────── */

export type ClosureResult =
  | { ok: true; schedule: ScheduledDeletion; alreadyClosed: boolean; stoppedSubscriptions: string[]; sharing: SharingRole }
  | { ok: false; code: ClosureErrorCode; message: string };

const closureError = (code: ClosureErrorCode): ClosureResult => ({ ok: false, code, message: CLOSURE_ERROR_MESSAGES[code] });

/**
 * Clôture le compte et programme sa suppression à J+30.
 *
 * Idempotente : une seconde demande (double clic, reprise après erreur)
 * renvoie le compte à rebours existant sans rappeler Stripe. Si une
 * précédente tentative s'est interrompue après la planification, les étapes
 * restantes sont rejouées.
 */
export async function closeAccountForDeletion(
  input: { userId: number; password?: string | null; confirmation?: string | null; now?: Date },
  deps: VoluntaryDeletionDeps = defaultDeps,
): Promise<ClosureResult> {
  const now = input.now ?? new Date();
  if (input.confirmation !== ACCOUNT_DELETION_CONFIRMATION) return closureError('INVALID_CONFIRMATION');
  if (!input.password) return closureError('PASSWORD_REQUIRED');

  const user = await deps.loadUser(input.userId);
  if (!user) return closureError('USER_NOT_FOUND');
  if (!(await deps.verifyPassword(input.password, user.passwordHash))) return closureError('INVALID_PASSWORD');

  const existing = await deps.getActiveUserSchedule(user.id);
  if (existing && user.status === PENDING_DELETION_STATUS) {
    return { ok: true, schedule: existing, alreadyClosed: true, stoppedSubscriptions: [], sharing: null };
  }
  if (user.status !== 'ACTIVE' && user.status !== PENDING_DELETION_STATUS) return closureError('USER_NOT_ACTIVE');
  if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') return closureError('ADMIN_ACCOUNT');

  const accountId = existing?.accountId ?? await deps.resolveAccount(user.id);
  if (accountId == null) return closureError('NO_ACCOUNT');

  // 1. Plus de renouvellement — AVANT toute écriture : si Stripe est
  //    injoignable, rien n'est modifié et l'utilisateur réessaie.
  let stoppedSubscriptions: string[];
  try {
    stoppedSubscriptions = await deps.billing.stopRenewal(user.id);
  } catch (e) {
    if (e instanceof BillingUnavailableError) {
      console.warn(`[account-deletion] clôture refusée pour l'utilisateur ${user.id} : ${e.message}`);
      return closureError('BILLING_UNAVAILABLE');
    }
    throw e;
  }

  // 2. Compte à rebours (date figée) et registre RGPD.
  const schedule = existing ?? await deps.scheduleDeletion({
    accountId,
    userId: user.id,
    reason: 'VOLUNTARY',
    origin: 'user',
    confirmedAt: now,
    delayDays: VOLUNTARY_DELETION_DELAY_DAYS,
  });

  // 3. Clôture : l'usage normal cesse.
  await deps.markClosed(user.id, now);

  // 4. Partages rompus.
  const { role: sharing } = await deps.detachSharing(user.id, now);

  // 5. Toutes les sessions révoquées (la route rouvre celle de cet appareil,
  //    en mode « compte en cours de suppression »).
  await deps.revokeSessions(user.id, 'ACCOUNT_CLOSED');

  // 6. Confirmation par e-mail (dédupliquée par compte à rebours).
  try {
    await deps.notify({ type: 'ACCOUNT_DELETION_SCHEDULED', userId: user.id, scheduleId: schedule.id, scheduledAt: schedule.scheduledAt });
    await deps.markInitialEmailSent(schedule.id, now);
  } catch (e) {
    console.error(`[account-deletion] e-mail de clôture pour l'utilisateur ${user.id} :`, (e as Error).message);
  }

  console.info(
    `[account-deletion] utilisateur ${user.id} : compte clôturé, suppression programmée le ` +
    `${schedule.scheduledAt.toISOString()} (abonnement(s) sans renouvellement : ${stoppedSubscriptions.join(', ') || 'aucun'}).`,
  );
  return { ok: true, schedule, alreadyClosed: false, stoppedSubscriptions, sharing };
}

/* ── Annulation ────────────────────────────────────────────────────────── */

export type CancelResult =
  | { ok: true; cancelled: ScheduledDeletion | null }
  | { ok: false; code: 'NOT_PENDING' | 'USER_NOT_FOUND' | 'IN_PROGRESS' };

/**
 * Annule la suppression et rétablit l'accès normal. Ne recrée ni abonnement
 * ni partage (voir l'en-tête).
 */
export async function cancelAccountDeletion(
  input: { userId: number; now?: Date },
  deps: VoluntaryDeletionDeps = defaultDeps,
): Promise<CancelResult> {
  const now = input.now ?? new Date();
  const user = await deps.loadUser(input.userId);
  if (!user) return { ok: false, code: 'USER_NOT_FOUND' };
  const active = await deps.getActiveUserSchedule(user.id);
  if (!active && user.status !== PENDING_DELETION_STATUS) return { ok: false, code: 'NOT_PENDING' };

  let cancelled: ScheduledDeletion | null;
  try {
    cancelled = await deps.cancelUserDeletion(user.id, 'à la demande de l’utilisateur', now);
  } catch (e) {
    // Exécution réservée par le balayage : plus d'annulation possible.
    if (e instanceof DeletionError && e.code === 'DELETION_IN_PROGRESS') return { ok: false, code: 'IN_PROGRESS' };
    throw e;
  }
  // Les jetons émis pendant la clôture portent l'ancien statut : révoqués,
  // la route rouvre une session normale sur cet appareil.
  await deps.revokeSessions(user.id, 'ACCOUNT_DELETION_CANCELLED');
  return { ok: true, cancelled };
}

export async function getAccountDeletionStatus(
  userId: number,
  now: Date = new Date(),
  deps: Pick<VoluntaryDeletionDeps, 'getActiveUserSchedule' | 'loadUser' | 'getLatestUserSchedule'> = defaultDeps,
): Promise<DeletionStatusView> {
  const active = await deps.getActiveUserSchedule(userId);
  if (active) return toStatusView(active, now);
  const user = await deps.loadUser(userId);
  if (user?.status !== PENDING_DELETION_STATUS) return toStatusView(null, now);
  const latest = await deps.getLatestUserSchedule(userId);
  return {
    status: 'closed',
    confirmedAt: latest?.confirmedAt.toISOString() ?? null,
    scheduledAt: latest?.scheduledAt.toISOString() ?? null,
    daysLeft: latest ? daysUntil(latest.scheduledAt, now) : null,
  };
}

/* ── Balayage quotidien (J-7, J+30) ────────────────────────────────────── */

export { accountDeletionSweepMode, sweepOptionsFor, type SweepMode } from './account-deletion.rules';

/**
 * Verrou d'EXÉCUTION partagé par la tâche interne quotidienne et la route
 * GET /api/cron/account-deletion/process : jamais deux balayages en même
 * temps (même base `job_locks` que le planificateur). Distinct du bail
 * quotidien `daily-account-deletion`, conservé 20 h pour cadencer la tâche :
 * le réutiliser bloquerait la route toute la journée.
 */
export const ACCOUNT_DELETION_SWEEP_LOCK = 'account-deletion-sweep';
const SWEEP_LOCK_TTL_MS = 60 * 60 * 1000;

export interface SweepLock {
  acquire: (name: string, ttlMs: number) => Promise<unknown | null>;
  release: (handle: never) => Promise<void>;
}

/** Balayage sous verrou ; `null` si un autre balayage est en cours. */
export async function runAccountDeletionSweepExclusive(
  options: { now?: Date; dryRun?: boolean; includeBacklog?: boolean } = {},
  deps: VoluntaryDeletionDeps = defaultDeps,
  lock?: SweepLock,
): Promise<AccountDeletionSweepResult | null> {
  const l: SweepLock = lock ?? await import('@/lib/job-lock').then((m) => ({
    acquire: m.acquireJobLock as SweepLock['acquire'],
    release: m.releaseJobLock as unknown as SweepLock['release'],
  }));
  const handle = await l.acquire(ACCOUNT_DELETION_SWEEP_LOCK, SWEEP_LOCK_TTL_MS);
  if (!handle) return null;
  try {
    return await runAccountDeletionSweep(options, deps);
  } finally {
    await l.release(handle as never).catch(() => undefined);
  }
}

export interface AccountDeletionSweepResult {
  dryRun: boolean;
  reminders: { j7: number; j1: number; emails: number };
  deletions: { executed: number; skipped: number; failed: number; deferred: number; backlog: number };
  failures: Array<{ scheduleId: number; accountId: number; reason?: string }>;
  deferred: Array<{ scheduleId: number; accountId: number; reason: string }>;
  /** Échéances anciennes non exécutées (arriéré, voir `includeBacklog`). */
  backlog: Array<{ scheduleId: number; accountId: number; scheduledAt: Date }>;
  finalEmails: { sent: number; abandoned: number };
  overdue: Array<{ scheduleId: number; accountId: number; scheduledAt: Date }>;
}

/**
 * Au-delà, une échéance jamais tentée est un ARRIÉRÉ (ex. suppressions de
 * rétractation accumulées tant qu'aucun planificateur ne tournait) : elle
 * n'est exécutée que sur décision explicite (`ACCOUNT_DELETION_SWEEP=live`).
 */
export const BACKLOG_DAYS = 7;

export function isBacklog(item: Pick<ScheduledDeletion, 'scheduledAt' | 'attemptCount'>, now: Date): boolean {
  return item.attemptCount === 0 && item.scheduledAt.getTime() < now.getTime() - BACKLOG_DAYS * DAY_MS;
}

/**
 * Balayage quotidien des suppressions planifiées, toutes portées confondues :
 * rappels, exécution des échéances, confirmations finales en attente.
 *
 * Idempotent et reprenable : chaque étape est rejouable (e-mails
 * dédupliqués, résiliations et sorties de Duo sans effet si déjà faites,
 * exécution sous verrou et sans effet sur un compte à rebours déjà clos).
 * Une suppression volontaire dont la résiliation Stripe échoue reste
 * programmée ; une exécution en échec est reprogrammée avec un délai
 * croissant et signalée en anomalie.
 *
 * @param includeBacklog exécute aussi les échéances de plus de
 *   `BACKLOG_DAYS` jours jamais tentées. Sinon elles sont ignorées et
 *   signalées une fois en anomalie.
 */
export async function runAccountDeletionSweep(
  options: { now?: Date; dryRun?: boolean; includeBacklog?: boolean } = {},
  deps: VoluntaryDeletionDeps = defaultDeps,
): Promise<AccountDeletionSweepResult> {
  const now = options.now ?? new Date();
  const dryRun = Boolean(options.dryRun);
  const result: AccountDeletionSweepResult = {
    dryRun,
    reminders: { j7: 0, j1: 0, emails: 0 },
    deletions: { executed: 0, skipped: 0, failed: 0, deferred: 0, backlog: 0 },
    failures: [],
    deferred: [],
    backlog: [],
    finalEmails: { sent: 0, abandoned: 0 },
    overdue: [],
  };

  // 0. Confirmations finales restées en attente (envoi interrompu).
  if (!dryRun) await flushFinalEmails(now, deps, result);

  // 1. Rappels.
  const reminders = await deps.listDueReminders(now);
  for (const [which, items] of [['j7', reminders.j7], ['j1', reminders.j1]] as const) {
    for (const item of items) {
      result.reminders[which] += 1;
      if (dryRun) continue;
      // Suppression volontaire : un seul e-mail, le rappel « J-7 ». S'il n'a
      // pas pu partir à temps (balayage arrêté, compte à rebours créé à moins
      // de 7 jours), il part au moment du J-1 plutôt que jamais. Les autres
      // motifs gardent leur comportement (rappels marqués, e-mails portés par
      // leur propre parcours).
      const sendReminder = item.reason === 'VOLUNTARY' && item.userId != null
        && (which === 'j7' || !item.reminderJ7SentAt);
      if (sendReminder) {
        try {
          await deps.notify({
            type: 'ACCOUNT_DELETION_REMINDER',
            userId: item.userId as number,
            scheduleId: item.id,
            scheduledAt: item.scheduledAt,
            daysLeft: daysUntil(item.scheduledAt, now),
          });
          result.reminders.emails += 1;
        } catch (e) {
          console.error(`[account-deletion] rappel #${item.id} :`, (e as Error).message);
          continue; // non marqué : retenté au prochain passage
        }
        if (which === 'j1') await deps.markReminderSent(item.id, 'j7', now);
      }
      await deps.markReminderSent(item.id, which, now);
    }
  }

  // 2. Échéances.
  for (const item of await deps.listDueDeletions(now)) {
    if (!options.includeBacklog && isBacklog(item, now)) {
      result.deletions.backlog += 1;
      result.backlog.push({ scheduleId: item.id, accountId: item.accountId, scheduledAt: item.scheduledAt });
      if (!dryRun && !item.anomalyReportedAt) {
        await reportOnce(item, now, deps, 'Suppression de compte en attente depuis plus de 7 jours, non exécutée',
          `Arriéré : échéance du ${item.scheduledAt.toISOString()} ignorée tant que ACCOUNT_DELETION_SWEEP=live n’est pas défini explicitement.`);
      }
      continue;
    }

    let outcome: ExecutionResult | { deferred: string };
    try {
      outcome = item.reason === 'VOLUNTARY'
        ? await settleVoluntaryDeletion(item, now, dryRun, deps)
        : await deps.execute(item.id, { now, dryRun });
    } catch (e) {
      // Une échéance en erreur n'interrompt pas le balayage des suivantes.
      outcome = { status: 'failed', reason: (e as Error).message };
    }

    if ('deferred' in outcome) {
      result.deletions.deferred += 1;
      result.deferred.push({ scheduleId: item.id, accountId: item.accountId, reason: outcome.deferred });
    } else if (outcome.status === 'executed') {
      result.deletions.executed += 1;
    } else if (outcome.status === 'failed') {
      result.deletions.failed += 1;
      result.failures.push({ scheduleId: item.id, accountId: item.accountId, reason: outcome.reason });
      if (!dryRun) {
        if ((outcome.reason ?? '').startsWith('USER_NOT_CLOSED')) {
          // État terminal (FAILED) : signalé une seule fois.
          if (!item.anomalyReportedAt) {
            await reportOnce(item, now, deps, 'Suppression de compte bloquée : utilisateur non clôturé', outcome.reason ?? '');
          }
        } else {
          // Échec d'exécution : chaque occurrence est ajoutée à la même
          // anomalie (empreinte par compte à rebours).
          await deps.reportAnomaly({
            scheduleId: item.id, accountId: item.accountId,
            title: 'Suppression de compte à échéance non exécutée',
            reason: outcome.reason ?? 'échec',
          }).catch(() => undefined);
        }
      }
    } else {
      result.deletions.skipped += 1;
    }
  }

  result.overdue = (await deps.listOverdueDeletions(now)).map((o) => ({
    scheduleId: o.id,
    accountId: o.accountId,
    scheduledAt: o.scheduledAt,
  }));
  return result;
}

async function reportOnce(item: ScheduledDeletion, now: Date, deps: VoluntaryDeletionDeps, title: string, reason: string) {
  try {
    await deps.reportAnomaly({ scheduleId: item.id, accountId: item.accountId, title, reason });
    await deps.markAnomalyReported(item.id, now);
  } catch (e) {
    console.error(`[account-deletion] anomalie #${item.id} :`, (e as Error).message);
  }
}

/**
 * J+30 d'une suppression volontaire. Ordre imposé par la concurrence avec
 * l'annulation : RÉSERVATION sous verrou d'abord (compte à rebours encore
 * programmé, utilisateur toujours clôturé ; l'annulation est ensuite
 * refusée), puis seulement les étapes irréversibles (résiliation Stripe,
 * fin des partages), puis l'exécution — qui revérifie tout sous verrou.
 */
async function settleVoluntaryDeletion(
  item: ScheduledDeletion,
  now: Date,
  dryRun: boolean,
  deps: VoluntaryDeletionDeps,
): Promise<ExecutionResult | { deferred: string }> {
  if (dryRun) return deps.execute(item.id, { now, dryRun });

  const claim = await deps.claim(item.id, now);
  if (!claim.ok) {
    if (claim.reason === 'USER_NOT_CLOSED') {
      // Garde-fou : un utilisateur qui n'est PAS clôturé n'est jamais
      // supprimé. État incohérent → terminal (FAILED, motif), pour ne pas
      // ressortir à chaque passage ; l'anomalie est signalée une fois.
      const reason = `USER_NOT_CLOSED (statut ${claim.userStatus})`;
      await deps.markFailed(item.id, reason, now);
      return { status: 'failed', reason };
    }
    return { status: 'skipped', reason: claim.reason };
  }
  // Utilisateur disparu : l'exécution constate et clôt la trace.
  if (!claim.user) return deps.execute(item.id, { now });
  const user = claim.user;

  try {
    // Un client dont les données sont supprimées ne doit plus être prélevé.
    try {
      await deps.billing.cancelNow(user.id);
    } catch (e) {
      if (e instanceof BillingUnavailableError) {
        await deps.releaseClaim(item.id, now);
        return { deferred: `STRIPE_UNAVAILABLE: ${e.message}` };
      }
      throw e;
    }
    await deps.detachSharing(user.id, now);
    await deps.recordNotifyEmail(item.id, user.email);
  } catch (e) {
    await deps.releaseClaim(item.id, now);
    throw e;
  }

  // En cas d'échec, l'exécution reprogramme elle-même (réservation rendue).
  const execution = await deps.execute(item.id, { now });
  if (execution.status === 'executed') {
    await sendFinal(item.id, user.email, item.confirmedAt, now, deps);
  } else if (execution.status === 'skipped') {
    await deps.releaseClaim(item.id, now);
  }
  return execution;
}

async function sendFinal(scheduleId: number, email: string, confirmedAt: Date, now: Date, deps: VoluntaryDeletionDeps): Promise<boolean> {
  let sent = false;
  try {
    sent = await deps.sendFinalEmail(email, {
      requestedAt: formatDeletionDate(confirmedAt),
      deletedAt: formatDeletionDate(now),
    });
  } catch (e) {
    console.error(`[account-deletion] confirmation finale #${scheduleId} :`, (e as Error).message);
  }
  if (sent) await deps.closeFinalEmail(scheduleId, true, now);
  return sent;
}

async function flushFinalEmails(now: Date, deps: VoluntaryDeletionDeps, result: AccountDeletionSweepResult): Promise<void> {
  for (const p of await deps.listPendingFinalEmails()) {
    const executedAt = p.executedAt ?? now;
    if (now.getTime() - executedAt.getTime() > FINAL_EMAIL_RETRY_DAYS * DAY_MS) {
      // Abandon : l'adresse ne doit pas survivre indéfiniment à la suppression.
      await deps.closeFinalEmail(p.id, false, now);
      result.finalEmails.abandoned += 1;
      continue;
    }
    if (await sendFinal(p.id, p.email, p.confirmedAt, executedAt, deps)) result.finalEmails.sent += 1;
  }
}

/* ── Implémentations par défaut ────────────────────────────────────────── */

/** Statuts Stripe d'un abonnement qui facture encore (ou va facturer). */
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);
/** En impayé : résilié immédiatement dès la clôture (plus de service à régulariser). */
const UNPAID_STATUSES = new Set(['past_due', 'unpaid', 'incomplete']);

/**
 * Abonnements Stripe dont l'utilisateur est le PAYEUR : ceux des comptes dont
 * il est titulaire (tarification V2 et historique) et des Duo dont il est
 * titulaire. Jamais le Duo d'un autre, même si le compte personnel d'un
 * second utilisateur y est rattaché (`accounts.duo_account_id`).
 */
async function billedSubscriptionIds(userId: number): Promise<string[]> {
  const owned = await db
    .select({ id: accounts.id, legacy: accounts.stripeSubscriptionId })
    .from(accounts)
    .where(eq(accounts.ownerUserId, userId));
  const ids = new Set<string>();
  for (const a of owned) if (a.legacy) ids.add(a.legacy);
  if (owned.length > 0) {
    const v2 = await db
      .select({ sub: accountSubscriptions.stripeSubscriptionId })
      .from(accountSubscriptions)
      .where(and(inArray(accountSubscriptions.accountId, owned.map((a) => a.id)), isNotNull(accountSubscriptions.stripeSubscriptionId)));
    for (const r of v2) if (r.sub) ids.add(r.sub);
  }
  const duos = await db
    .select({ sub: duoAccounts.stripeSubscriptionId })
    .from(duoAccounts)
    .where(and(eq(duoAccounts.billingOwnerUserId, userId), isNotNull(duoAccounts.stripeSubscriptionId)));
  for (const d of duos) if (d.sub) ids.add(d.sub);
  return [...ids];
}

function stripeClient(): Pick<Stripe, 'subscriptions'> {
  try {
    return getStripeServer();
  } catch (e) {
    throw new BillingUnavailableError(`Stripe non configuré (${(e as Error).message})`);
  }
}

function isMissing(e: unknown): boolean {
  const err = e as { code?: string; statusCode?: number };
  return err?.code === 'resource_missing' || err?.statusCode === 404;
}

/**
 * Applique `action` aux abonnements facturant encore. Abonnement inconnu de
 * Stripe : ignoré. Toute autre erreur : `BillingUnavailableError`.
 */
export async function applyToLiveSubscriptions(
  ids: string[],
  stripe: () => Pick<Stripe, 'subscriptions'>,
  mode: 'stop_renewal' | 'cancel_now',
): Promise<string[]> {
  if (ids.length === 0) return [];
  const client = stripe();
  const touched: string[] = [];
  for (const id of ids) {
    try {
      const sub = await client.subscriptions.retrieve(id);
      if (!LIVE_STATUSES.has(sub.status)) continue;
      if (mode === 'cancel_now' || UNPAID_STATUSES.has(sub.status)) {
        await client.subscriptions.cancel(id, { invoice_now: false, prorate: false });
        touched.push(id);
      } else if (!sub.cancel_at_period_end) {
        await client.subscriptions.update(id, { cancel_at_period_end: true });
        touched.push(id);
      }
    } catch (e) {
      if (isMissing(e)) continue;
      throw new BillingUnavailableError(`abonnement ${id} : ${(e as Error).message}`);
    }
  }
  return touched;
}

async function detachSharingDefault(userId: number, now: Date): Promise<{ role: SharingRole; removedMemberships: number }> {
  let role: SharingRole = null;

  const [ownedDuo] = await db
    .select({ id: duoAccounts.id })
    .from(duoAccounts)
    .where(eq(duoAccounts.billingOwnerUserId, userId))
    .limit(1);
  if (ownedDuo) {
    role = 'duo_owner';
    // Service de fin de Duo existant (AID-DUO-005) : invitation annulée,
    // second utilisateur retiré, demandes annulées, biens déverrouillés.
    await endDuoSharing(userId);
    // `endDuoSharing` s'abstient pendant un impayé Duo (mode récupération) :
    // le titulaire partant, le membre est retiré quand même, par la même
    // sortie (`endMembership`).
    const remaining = await db
      .select({ id: duoMemberships.id, userId: duoMemberships.userId })
      .from(duoMemberships)
      .where(and(eq(duoMemberships.duoId, ownedDuo.id), eq(duoMemberships.status, 'ACTIVE'), ne(duoMemberships.userId, userId)));
    for (const m of remaining) {
      await endMembership({ duoId: ownedDuo.id, membershipId: m.id, memberUserId: m.userId, status: 'REMOVED' });
    }
  } else {
    const left = await leaveDuo(userId);
    if (left.ok) role = 'duo_member';
    else {
      const [was] = await db
        .select({ id: duoMemberships.id })
        .from(duoMemberships)
        .where(and(eq(duoMemberships.userId, userId), inArray(duoMemberships.status, ['LEFT', 'REMOVED'])))
        .limit(1);
      if (was) role = 'duo_member';
    }
  }

  // Comptes partagés (`account_memberships`) : autres utilisateurs et
  // invitations des comptes dont il est titulaire ; ses propres adhésions aux
  // comptes des autres.
  const owned = (await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.ownerUserId, userId))).map((a) => a.id);
  const removed = await db
    .update(accountMemberships)
    .set({ status: 'removed', removedAt: now, removedBy: userId, updatedAt: now })
    .where(and(
      inArray(accountMemberships.status, ['active', 'pending', 'ACTIVE']),
      or(
        owned.length > 0
          ? and(inArray(accountMemberships.accountId, owned), or(isNull(accountMemberships.userId), ne(accountMemberships.userId, userId)))
          : sql`false`,
        and(eq(accountMemberships.userId, userId), owned.length > 0 ? notInArray(accountMemberships.accountId, owned) : sql`true`),
      ),
    ))
    .returning({ id: accountMemberships.id });

  return { role, removedMemberships: removed.length };
}

export const defaultDeps: VoluntaryDeletionDeps = {
  async loadUser(userId) {
    const [u] = await db
      .select({
        id: users.id, email: users.email, firstName: users.firstName, passwordHash: users.passwordHash,
        status: users.status, role: users.role,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return u ?? null;
  },
  verifyPassword: (plain, hash) => (hash ? bcrypt.compare(plain, hash) : Promise.resolve(false)),
  async resolveAccount(userId) {
    const [owned] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.ownerUserId, userId))
      .orderBy(accounts.id)
      .limit(1);
    if (owned) return owned.id;
    const [member] = await db
      .select({ id: accountMemberships.accountId })
      .from(accountMemberships)
      .where(and(eq(accountMemberships.userId, userId), inArray(accountMemberships.status, ['active', 'ACTIVE'])))
      .orderBy(accountMemberships.id)
      .limit(1);
    return member?.id ?? null;
  },
  getActiveUserSchedule,
  scheduleDeletion,
  cancelUserDeletion,
  async markClosed(userId, now) {
    await db.update(users).set({ status: PENDING_DELETION_STATUS, updatedAt: now }).where(eq(users.id, userId));
    serverCacheDelete(`users:me:${userId}`);
  },
  billing: {
    async stopRenewal(userId) {
      const ids = await billedSubscriptionIds(userId);
      const touched = await applyToLiveSubscriptions(ids, stripeClient, 'stop_renewal');
      // Reflet local immédiat ; le webhook Stripe reste la source de vérité.
      if (touched.length > 0) {
        await db
          .update(accountSubscriptions)
          .set({ cancelAtPeriodEnd: true, updatedAt: new Date() })
          .where(inArray(accountSubscriptions.stripeSubscriptionId, touched))
          .catch(() => undefined);
      }
      return touched;
    },
    async cancelNow(userId) {
      return applyToLiveSubscriptions(await billedSubscriptionIds(userId), stripeClient, 'cancel_now');
    },
  },
  detachSharing: detachSharingDefault,
  async revokeSessions(userId, reason) {
    const cutoff = await revokeAllUserSessions(userId, reason);
    serverCacheDelete(sessionCutoffCacheKey(userId));
    serverCacheDelete(`users:me:${userId}`);
    return cutoff;
  },
  async notify({ type, userId, scheduleId, scheduledAt, daysLeft }) {
    const iso = scheduledAt.toISOString();
    if (type === 'ACCOUNT_DELETION_SCHEDULED') {
      await emit({
        type, recipientUserIds: [userId], entityType: 'user', entityId: userId,
        payload: { scheduledAt: iso },
        dedupeKey: `account-deletion:${scheduleId}:scheduled`,
      });
    } else {
      await emit({
        type, recipientUserIds: [userId], entityType: 'user', entityId: userId,
        payload: { scheduledAt: iso, daysLeft: daysLeft ?? 7 },
        dedupeKey: `account-deletion:${scheduleId}:j7`,
      });
    }
  },
  async markInitialEmailSent(scheduleId, now) {
    await db
      .update(scheduledAccountDeletions)
      .set({ initialEmailSentAt: now, updatedAt: now })
      .where(and(eq(scheduledAccountDeletions.id, scheduleId), isNull(scheduledAccountDeletions.initialEmailSentAt)));
  },
  listDueReminders,
  markReminderSent,
  listDueDeletions,
  listOverdueDeletions,
  execute: (id, options) => executeScheduledDeletion(id, options),
  async recordNotifyEmail(scheduleId, email) {
    await db
      .update(scheduledAccountDeletions)
      .set({ notifyEmail: email })
      .where(and(eq(scheduledAccountDeletions.id, scheduleId), isNull(scheduledAccountDeletions.finalEmailSentAt)));
  },
  async listPendingFinalEmails() {
    const rows = await db
      .select({
        id: scheduledAccountDeletions.id,
        email: scheduledAccountDeletions.notifyEmail,
        confirmedAt: scheduledAccountDeletions.confirmedAt,
        executedAt: scheduledAccountDeletions.executedAt,
        status: scheduledAccountDeletions.status,
      })
      .from(scheduledAccountDeletions)
      .where(and(
        isNotNull(scheduledAccountDeletions.notifyEmail),
        isNull(scheduledAccountDeletions.finalEmailSentAt),
        inArray(scheduledAccountDeletions.status, ['EXECUTED', 'FAILED', 'CANCELLED']),
      ));
    // Seules les suppressions EXÉCUTÉES reçoivent la confirmation ; pour les
    // autres (échec, annulation), l'adresse relevée est simplement effacée.
    const out: Array<{ id: number; email: string; confirmedAt: Date; executedAt: Date | null }> = [];
    for (const r of rows) {
      if (r.status !== 'EXECUTED') {
        await db.update(scheduledAccountDeletions).set({ notifyEmail: null }).where(eq(scheduledAccountDeletions.id, r.id));
        continue;
      }
      out.push({ id: r.id, email: r.email as string, confirmedAt: r.confirmedAt, executedAt: r.executedAt ?? null });
    }
    return out;
  },
  async sendFinalEmail(to, vars) {
    const res = await emailService.send({ templateCode: 'account_deletion_completed', to, variables: vars });
    return res.success;
  },
  getLatestUserSchedule,
  claim: claimUserDeletion,
  releaseClaim: releaseUserDeletionClaim,
  markFailed: markDeletionFailed,
  async reportAnomaly({ scheduleId, accountId, title, reason }) {
    const { reportAnomaly, buildFingerprint } = await import('@/services/admin/anomaly.service');
    await reportAnomaly({
      domain: 'other',
      fingerprint: buildFingerprint('other', 'account-deletion', scheduleId),
      title,
      detail: { scheduleId, accountId, reason },
    });
  },
  markAnomalyReported,
  async closeFinalEmail(scheduleId, sent, now) {
    await db
      .update(scheduledAccountDeletions)
      .set({ notifyEmail: null, ...(sent ? { finalEmailSentAt: now } : {}), updatedAt: now })
      .where(eq(scheduledAccountDeletions.id, scheduleId));
  },
};
