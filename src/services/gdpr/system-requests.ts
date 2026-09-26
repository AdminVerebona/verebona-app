/**
 * Demandes RGPD « système » — CDC Back-Office V1 GDP-007 à GDP-009.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ALIMENTÉES PAR LES FAITS, JAMAIS PAR LE BACK-OFFICE
 *
 * Une demande système naît d'un fait de l'application (suppression engagée
 * par l'utilisateur, export « Mes données ») et son statut suit ce fait :
 * le BO la consulte, n'y touche pas (refus côté API, `rules.planManualUpdate`).
 *
 * `source_ref` (unique) rattache la demande à son fait générateur : rejouer
 * un hook ne crée jamais de doublon.
 *
 * BEST-EFFORT : un échec d'écriture du registre est journalisé mais ne fait
 * jamais échouer la suppression ou l'export qui l'a déclenché. Le registre
 * suit le fait ; il ne doit pas l'empêcher.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { computeDueDateFromInstant, type GdprRightType, type GdprStatus } from './rules';

type DeletionReason = 'WITHDRAWAL' | 'VOLUNTARY' | 'TRIAL_ABANDONED' | 'ADMIN' | 'UNPAID';
type DeletionOrigin = 'user' | 'system' | 'admin';

/**
 * Une suppression planifiée alimente-t-elle le registre RGPD ?
 *
 * Oui lorsqu'elle est initiée par l'utilisateur (GDP-008) : demande
 * volontaire ou rétractation (dont la suppression des données est la
 * conséquence annoncée). Non pour la purge d'un essai abandonné (traitement
 * de conservation, pas l'exercice d'un droit) ni pour une suppression
 * engagée depuis le BO — celle-ci exécute, le cas échéant, une demande
 * manuelle que le support a saisie.
 */
export function deletionCreatesGdprRequest(reason: DeletionReason, origin: DeletionOrigin): boolean {
  return origin === 'user' && (reason === 'VOLUNTARY' || reason === 'WITHDRAWAL');
}

const DELETION_REASON_LABELS: Record<DeletionReason, string> = {
  VOLUNTARY: 'demande de suppression du compte',
  WITHDRAWAL: 'rétractation',
  TRIAL_ABANDONED: 'essai abandonné',
  ADMIN: 'back-office',
  // Cycle d'impayé de 90 jours (Centre d'aide GAP-06) : origine système.
  UNPAID: 'impayé non régularisé',
};

export interface SystemRequestInput {
  sourceRef: string;
  rightType: GdprRightType;
  userId: number | null;
  accountId: number | null;
  receivedAt: Date;
  status: GdprStatus;
  result?: string | null;
  /** Ne pas figer l'e-mail (déjà anonymisé ou effacé). */
  withoutEmailSnapshot?: boolean;
}

/** Crée la demande si elle n'existe pas encore. Renvoie son identifiant. */
export async function upsertSystemRequest(input: SystemRequestInput): Promise<number | null> {
  const due = computeDueDateFromInstant(input.receivedAt, input.rightType);
  const processedAt = input.status === 'done' ? new Date() : null;
  const [row] = await pgClient<{ id: number }[]>`
    INSERT INTO gdpr_requests (
      origin, user_id, account_id, subject_user_ref, subject_account_ref,
      subject_email, subject_account_name, right_type, channel, status,
      received_at, due_date, processed_at, result, source_ref, created_at, updated_at
    )
    SELECT 'system', ${input.userId}::int, ${input.accountId}::int, ${input.userId}::int, ${input.accountId}::int,
           ${input.withoutEmailSnapshot ? pgClient`NULL::text` : pgClient`(SELECT email FROM users WHERE id = ${input.userId}::int)`},
           (SELECT name FROM accounts WHERE id = ${input.accountId}::int),
           ${input.rightType}::text, 'app', ${input.status}::text,
           ${input.receivedAt}::timestamptz, ${due}::date, ${processedAt}::timestamptz, ${input.result ?? null}::text,
           ${input.sourceRef}::text, now(), now()
    ON CONFLICT (source_ref) DO NOTHING
    RETURNING id`;
  if (row) return Number(row.id);
  const [existing] = await pgClient<{ id: number }[]>`
    SELECT id FROM gdpr_requests WHERE source_ref = ${input.sourceRef}`;
  return existing ? Number(existing.id) : null;
}

export interface SystemProgress {
  status?: GdprStatus;
  result?: string | null;
  lastError?: string | null;
  /** Efface l'e-mail et le nom de compte figés (suppression exécutée). */
  pseudonymize?: boolean;
}

/** Fait avancer une demande système. N'affecte jamais une demande manuelle. */
export async function updateSystemRequest(where: { sourceRef: string } | { id: number }, p: SystemProgress): Promise<void> {
  const byRef = 'sourceRef' in where;
  const key = byRef ? where.sourceRef : where.id;
  const status = p.status ?? null;
  await pgClient`
    UPDATE gdpr_requests SET
      status       = coalesce(${status}::text, status),
      processed_at = CASE
                       WHEN ${status}::text = 'done' THEN coalesce(processed_at, now())
                       WHEN ${status}::text IS NOT NULL THEN NULL
                       ELSE processed_at
                     END,
      result       = CASE WHEN ${p.result !== undefined} THEN ${p.result ?? null}::text ELSE result END,
      last_error   = CASE WHEN ${p.lastError !== undefined} THEN ${p.lastError ?? null}::text ELSE last_error END,
      subject_email        = CASE WHEN ${!!p.pseudonymize} THEN NULL ELSE subject_email END,
      subject_account_name = CASE WHEN ${!!p.pseudonymize} THEN NULL ELSE subject_account_name END,
      updated_at   = now()
    WHERE origin = 'system'
      AND ${byRef ? pgClient`source_ref = ${key as string}` : pgClient`id = ${key as number}`}`;
}

async function safely(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[gdpr] ${label} : registre non mis à jour —`, (e as Error)?.message ?? e);
  }
}

const deletionRef = (scheduleId: number) => `scheduled_deletion:${scheduleId}`;
const frDate = (d: Date) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long' }).format(d);

/* ── Hooks du workflow de suppression (scheduled-deletion.service) ─────── */

export function onDeletionScheduled(s: {
  id: number; accountId: number; userId: number | null; reason: DeletionReason; origin: DeletionOrigin;
  confirmedAt: Date; scheduledAt: Date;
}): Promise<void> {
  if (!deletionCreatesGdprRequest(s.reason, s.origin)) return Promise.resolve();
  return safely(`suppression planifiée #${s.id}`, () => upsertSystemRequest({
    sourceRef: deletionRef(s.id),
    rightType: 'erasure',
    userId: s.userId,
    accountId: s.accountId,
    receivedAt: s.confirmedAt,
    status: 'in_progress',
    result: `Suppression planifiée au ${frDate(s.scheduledAt)} (${DELETION_REASON_LABELS[s.reason]}).`,
  }));
}

export function onDeletionCancelled(scheduleId: number, reason: string): Promise<void> {
  return safely(`suppression annulée #${scheduleId}`, () => updateSystemRequest(
    { sourceRef: deletionRef(scheduleId) },
    { status: 'done', result: `Suppression annulée par le système : ${reason}.`, lastError: null },
  ));
}

export function onDeletionExecuted(scheduleId: number, at: Date): Promise<void> {
  return safely(`suppression exécutée #${scheduleId}`, () => updateSystemRequest(
    { sourceRef: deletionRef(scheduleId) },
    { status: 'done', result: `Compte et données supprimés le ${frDate(at)}.`, lastError: null, pseudonymize: true },
  ));
}

export function onDeletionFailed(scheduleId: number, reason: string): Promise<void> {
  return safely(`suppression en échec #${scheduleId}`, () => updateSystemRequest(
    { sourceRef: deletionRef(scheduleId) },
    { lastError: reason.slice(0, 2000) },
  ));
}

/**
 * Suppression immédiate en libre-service (`DELETE /api/users/me`) :
 * l'utilisateur est anonymisé dans la requête, la demande naît donc traitée.
 * Aucun e-mail figé : il vient d'être effacé.
 */
export function onSelfServiceDeletion(userId: number, accountId: number | null, at: Date = new Date()): Promise<void> {
  return safely(`suppression libre-service utilisateur #${userId}`, () => upsertSystemRequest({
    sourceRef: `self_deletion:${userId}`,
    rightType: 'erasure',
    userId,
    accountId,
    receivedAt: at,
    status: 'done',
    result: 'Compte utilisateur anonymisé à la demande de l’utilisateur (suppression en libre-service).',
    withoutEmailSnapshot: true,
  }));
}
