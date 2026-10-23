/**
 * Notification de RÉSULTAT d'un lot d'analyse — CDC notifications §7.2,
 * établie depuis les états réels au lot 81E.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE NOTIFICATION PAR LOT, JAMAIS PAR DOCUMENT
 *
 * Un utilisateur qui dépose vingt documents ne reçoit pas vingt
 * notifications (le lot 0 a supprimé la route `notify-analyzed`, qui en créait
 * une par fichier). La clé de déduplication porte l'identifiant du lot :
 * un rejeu ou une reprise ne produit pas une seconde notification.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 81E — LE RÉSULTAT RÉEL, PAS UN COMPTEUR
 *
 * Écarts corrigés (audit du lot 79C) : un lot entièrement échoué ne
 * produisait AUCUNE notification ; un lot partiellement échoué était annoncé
 * comme réussi (`failedCount` forcé à 0) ; le nombre d'échecs était calculé
 * comme « sources demandées − analysées » et comptait donc comme échecs les
 * doublons et les fichiers regroupés.
 *
 * Le résultat est désormais établi depuis les états PERSISTÉS de chaque
 * document du lot (`asset_files`, file durable T1) :
 *   · ANALYSÉ    état abouti (analysé, à valider, conflit) ;
 *   · DOUBLON    fusion suggérée — analysé, jamais un échec ;
 *   · REGROUPÉ   fichier secondaire rattaché au document principal — ni
 *                compté, ni un échec ;
 *   · ÉCHEC      `ANALYSIS_FAILED` sans reprise automatique en cours ni
 *                prévue (aucun travail vivant dans la file durable) ;
 *   · EN COURS   analyse en cours, en file, reprise automatique prévue après
 *                un échec transitoire : rien n'est annoncé comme définitif ;
 *   · REPORTÉ    plafond mensuel de coût IA : analysé le mois suivant, il
 *                sera annoncé alors (son propre lot) ;
 *   · RETIRÉ     document supprimé entre-temps.
 * Tant qu'un document est EN COURS, le lot reste « en attente »
 * (`document_lots.notification_state = 'awaiting'`) ; il est réévalué à la
 * fin de chaque exécution de la file durable (`onT1JobSettled`), après une
 * remise en file hors file, et par la tâche `document-lot-notifications`
 * (filet). La reprise d'un document dans un nouveau lot est rattachée au
 * lot d'origine encore en attente (`absorbed`) : un seul résultat annoncé.
 *
 * Issue : réussite totale (`DOCUMENT_BATCH_COMPLETED`), réussite partielle
 * (`DOCUMENT_BATCH_PARTIALLY_FAILED`) ou échec total (`DOCUMENT_BATCH_FAILED`),
 * documents nommés, une seule notification. Canaux du lot 79C inchangés :
 * information dans l'application, push facultatif, jamais d'e-mail.
 * L'action proposée (relancer depuis la fiche du document) existe réellement.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { emit } from '@/lib/notifications';
import {
  LOT_DOCUMENTS_MAX, lotFailurePayload, lotNotificationPayload,
  type LotDocument, type LotOutcomeType,
} from './lot-notification-text';

export { lotNotificationPayload, lotNotificationText, type LotDocument } from './lot-notification-text';

export interface LotNotificationInput {
  accountId: number;
  userId?: number;
  lotId: number;
  /** Informatifs (journal) : le résultat est relu en base. */
  analysedCount: number;
  failedCount: number;
  /**
   * Sources en échec dont l'appelant PRÉVOIT une reprise automatique (file
   * durable : le travail va être repris ou clos ; hors file : remise en file
   * par l'entrée unique). Jamais annoncées comme définitives à ce stade.
   */
  retryExpectedSourceIds?: number[];
}

/** Issue d'un document du lot, établie depuis son état persisté. */
export type LotItemOutcome = 'ANALYSED' | 'DUPLICATE' | 'GROUPED' | 'FAILED' | 'IN_PROGRESS' | 'DEFERRED' | 'REMOVED';

export interface LotItemState {
  assetFileId: number;
  title: string | null;
  analysisState: string | null;
  analysisFailReason?: string | null;
  deleted: boolean;
  groupedInto: number | null;
  /** Travail vivant (en file / en cours) dans la file durable T1. */
  liveJob: boolean;
  /** Reprise annoncée par l'exécution qui vient de se terminer. */
  retryExpected: boolean;
}

const ABOUTIS = new Set(['ANALYZED', 'VALIDATION_REQUIRED', 'CONFLICT_DETECTED']);
/** Motif posé par le plafond mensuel de coût IA (`account-cost-cap`, même préfixe que le pipeline). */
const COST_CAP_PREFIX = 'Plafond IA du mois atteint';

/** Issue d'un document (pure). */
export function classifyLotItem(s: LotItemState): LotItemOutcome {
  if (s.deleted) return s.groupedInto != null ? 'GROUPED' : 'REMOVED';
  if (s.analysisState && ABOUTIS.has(s.analysisState)) return 'ANALYSED';
  if (s.analysisState === 'FUSION_SUGGESTED') return 'DUPLICATE';
  if (s.analysisState === 'ANALYSIS_FAILED') return s.liveJob || s.retryExpected ? 'IN_PROGRESS' : 'FAILED';
  if (s.analysisState === 'UPLOADED' && (s.analysisFailReason ?? '').startsWith(COST_CAP_PREFIX)) return 'DEFERRED';
  return 'IN_PROGRESS';
}

export interface LotOutcome {
  /** Tous les documents ont une issue définitive. */
  final: boolean;
  type: LotOutcomeType | null;
  analysed: LotDocument[];
  duplicates: number;
  failed: LotDocument[];
}

/**
 * Type de notification correspondant à l'issue (pure) : réussite totale,
 * réussite partielle, échec total ; `null` : rien à annoncer (aucun document
 * ni analysé ni en échec — tout regroupé, retiré ou reporté).
 */
export function resolveLotNotificationType(analysedCount: number, failedCount: number): LotOutcomeType | null {
  if (failedCount > 0) return analysedCount > 0 ? 'DOCUMENT_BATCH_PARTIALLY_FAILED' : 'DOCUMENT_BATCH_FAILED';
  return analysedCount > 0 ? 'DOCUMENT_BATCH_COMPLETED' : null;
}

/** Issue du lot (pure). */
export function resolveLotOutcome(items: LotItemState[]): LotOutcome {
  const analysed: LotDocument[] = [];
  const failed: LotDocument[] = [];
  let duplicates = 0;
  let final = true;
  const doc = (i: LotItemState): LotDocument => ({ assetFileId: i.assetFileId, title: i.title ?? '' });
  for (const i of items) {
    switch (classifyLotItem(i)) {
      case 'ANALYSED': analysed.push(doc(i)); break;
      case 'DUPLICATE': analysed.push(doc(i)); duplicates += 1; break;
      case 'FAILED': failed.push(doc(i)); break;
      case 'IN_PROGRESS': final = false; break;
      default: break;
    }
  }
  return { final, type: final ? resolveLotNotificationType(analysed.length, failed.length) : null, analysed, duplicates, failed };
}

/**
 * Documents analysés d'un lot, avec leur titre retenu. Ne lève jamais :
 * sans titres, la notification reste émise, simplement moins précise.
 */
export async function loadLotDocuments(lotId: number): Promise<LotDocument[]> {
  try {
    const { db } = await import('@/db');
    const rows = await db.$client<{ assetFileId: number; title: string | null }[]>`
      SELECT li.asset_file_id AS "assetFileId",
             COALESCE(NULLIF(af.retained_title, ''), NULLIF(af.original_filename, ''), af.filename) AS title
      FROM document_lot_items li
      JOIN asset_files af ON af.id = li.asset_file_id
      WHERE li.lot_id = ${lotId} AND li.analysis_status = 'completed' AND af.deleted_at IS NULL
      ORDER BY li.position ASC
      LIMIT ${LOT_DOCUMENTS_MAX + 1}
    `;
    return rows.filter((r) => r.title).map((r) => ({ assetFileId: r.assetFileId, title: r.title as string }));
  } catch (e) {
    console.warn(`[source-analysis] titres du lot ${lotId} non lus :`, (e as Error).message);
    return [];
  }
}

/** Fichiers ayant un travail T1 vivant (en file ou en cours). Illisible : tous réputés vivants. */
async function liveFiles(ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  try {
    const { listLiveTargets } = await import('@/services/ai/queue/job-queue.repository');
    return new Set([...(await listLiveTargets('T1', 'asset_file', ids))].map(Number));
  } catch (e) {
    console.warn('[source-analysis] file durable illisible — résultat du lot différé :', (e as Error).message);
    return new Set(ids);
  }
}

interface LotRow { id: number; account_id: number; notification_state: string | null; notification_user_id: number | null }

/**
 * Réévalue le résultat d'un lot « en attente » et, s'il est définitif, émet
 * l'unique notification de son résultat. Idempotent (transition conditionnelle
 * `awaiting` → `notified`, clé de déduplication du lot). Ne lève jamais.
 */
export async function evaluateLotNotification(lotId: number, opts: { retryExpected?: ReadonlySet<number> } = {}): Promise<'notified' | 'awaiting' | 'absorbed' | 'silent' | 'skipped'> {
  try {
    const { pgClient } = await import('@/db');
    const [lot] = await pgClient.unsafe<LotRow[]>(
      `SELECT id, account_id, notification_state, notification_user_id FROM document_lots WHERE id = $1`, [lotId] as never[]);
    if (!lot || lot.notification_state !== 'awaiting') return 'skipped';

    const items = await pgClient.unsafe<Array<{
      asset_file_id: number; title: string | null; analysis_state: string | null; analysis_fail_reason: string | null;
      deleted: boolean; grouped_into: number | null; earlier_lot: number | null;
    }>>(
      `SELECT li.asset_file_id,
              COALESCE(NULLIF(af.retained_title, ''), NULLIF(af.original_filename, ''), af.filename) AS title,
              af.analysis_state, af.analysis_fail_reason,
              (af.deleted_at IS NOT NULL) AS deleted, af.grouped_into_file_id AS grouped_into,
              (SELECT min(l2.id) FROM document_lot_items i2 JOIN document_lots l2 ON l2.id = i2.lot_id
                WHERE i2.asset_file_id = li.asset_file_id AND l2.id < li.lot_id
                  AND l2.notification_state = 'awaiting') AS earlier_lot
         FROM document_lot_items li
         JOIN asset_files af ON af.id = li.asset_file_id
        WHERE li.lot_id = $1
        ORDER BY li.position`,
      [lotId] as never[],
    );

    // Reprise d'un document déjà suivi par un lot antérieur encore en
    // attente : son résultat appartient à ce lot d'origine.
    const anterieurs = [...new Set(items.map((i) => i.earlier_lot).filter((x): x is number => x != null))];
    const propres = items.filter((i) => i.earlier_lot == null);
    if (propres.length === 0 && anterieurs.length > 0) {
      await pgClient.unsafe(
        `UPDATE document_lots SET notification_state = 'absorbed', notification_absorbed_into = $2, notification_settled_at = now()
          WHERE id = $1 AND notification_state = 'awaiting'`, [lotId, anterieurs[0]] as never[]);
      for (const l of anterieurs) await evaluateLotNotification(l, opts);
      return 'absorbed';
    }
    for (const l of anterieurs) await evaluateLotNotification(l, opts);

    const vivants = await liveFiles(propres.filter((i) => i.analysis_state === 'ANALYSIS_FAILED').map((i) => i.asset_file_id));
    const outcome = resolveLotOutcome(propres.map((i) => ({
      assetFileId: i.asset_file_id, title: i.title, analysisState: i.analysis_state, analysisFailReason: i.analysis_fail_reason,
      deleted: i.deleted, groupedInto: i.grouped_into,
      liveJob: vivants.has(i.asset_file_id), retryExpected: opts.retryExpected?.has(i.asset_file_id) ?? false,
    })));
    if (!outcome.final) return 'awaiting';

    if (!outcome.type || lot.notification_user_id == null) {
      await pgClient.unsafe(
        `UPDATE document_lots SET notification_state = 'silent', notification_settled_at = now() WHERE id = $1 AND notification_state = 'awaiting'`,
        [lotId] as never[]);
      return 'silent';
    }

    // Prise atomique : une seule évaluation concurrente émet.
    const prise = await pgClient.unsafe<{ id: number }[]>(
      `UPDATE document_lots SET notification_state = 'notified', notification_outcome = $2, notification_settled_at = now()
        WHERE id = $1 AND notification_state = 'awaiting' RETURNING id`,
      [lotId, outcome.type.replace('DOCUMENT_BATCH_', '')] as never[]);
    if (prise.length === 0) return 'skipped';

    const payload = outcome.type === 'DOCUMENT_BATCH_COMPLETED'
      ? { ...lotNotificationPayload(lotId, outcome.analysed.length, outcome.analysed), ...(outcome.duplicates ? { duplicateCount: outcome.duplicates } : {}) }
      : lotFailurePayload(lotId, outcome.analysed.length, outcome.failed);
    try {
      await emit({
        type: outcome.type,
        recipientUserIds: [lot.notification_user_id],
        accountId: lot.account_id,
        entityType: 'document_lot',
        entityId: lotId,
        payload: payload as never,
        // Stable : un rejeu du même lot ne produit pas une seconde
        // notification (§7.2, et défaut de la route supprimée au lot 0).
        dedupeKey: `document:lot-result:${lotId}`,
      });
    } catch (e) {
      // Rien n'est perdu : le lot repasse en attente, le filet le reprendra.
      await pgClient.unsafe(
        `UPDATE document_lots SET notification_state = 'awaiting', notification_outcome = NULL, notification_settled_at = NULL WHERE id = $1`,
        [lotId] as never[]).catch(() => undefined);
      throw e;
    }
    return 'notified';
  } catch (e) {
    console.error(`[source-analysis] résultat du lot ${lotId} non notifié :`, (e as Error).message);
    return 'skipped';
  }
}

/**
 * Lots en attente contenant ces documents : réévalués (fin d'une exécution de
 * la file durable, remise en file). Ne lève jamais.
 */
export async function settleLotNotificationsForFiles(fileIds: number[]): Promise<void> {
  if (fileIds.length === 0) return;
  try {
    const { pgClient } = await import('@/db');
    const lots = await pgClient.unsafe<{ id: number }[]>(
      `SELECT DISTINCT l.id FROM document_lots l JOIN document_lot_items li ON li.lot_id = l.id
        WHERE l.notification_state = 'awaiting' AND li.asset_file_id = ANY($1::int[])
        ORDER BY l.id`,
      [fileIds] as never[]);
    for (const l of lots) await evaluateLotNotification(l.id);
  } catch (e) {
    console.error('[source-analysis] réévaluation des lots en attente impossible :', (e as Error).message);
  }
}

/** Filet : au-delà, un lot en attente n'est plus réévalué (journalisé, état `expired`). */
export const LOT_NOTIFICATION_MAX_AGE_DAYS = 30;

/**
 * Tâche `document-lot-notifications` : réévalue les lots en attente depuis
 * plus de `minAgeMs` (remise en file perdue, processus arrêté) ; clôt sans
 * notification les lots trop anciens. Idempotente.
 */
export async function runLotNotificationSweep(opts: { now?: Date; minAgeMs?: number; limit?: number } = {}): Promise<{ evaluated: number; notified: number; expired: number }> {
  const now = opts.now ?? new Date();
  const { pgClient } = await import('@/db');
  const expired = await pgClient.unsafe<{ id: number }[]>(
    `UPDATE document_lots SET notification_state = 'expired', notification_settled_at = $1::timestamptz
      WHERE notification_state = 'awaiting' AND created_at < $1::timestamptz - make_interval(days => $2)
      RETURNING id`,
    [now.toISOString(), LOT_NOTIFICATION_MAX_AGE_DAYS] as never[]);
  if (expired.length) console.warn(`[source-analysis] ${expired.length} lot(s) sans issue après ${LOT_NOTIFICATION_MAX_AGE_DAYS} jours : ${expired.map((r) => r.id).join(', ')}`);
  const lots = await pgClient.unsafe<{ id: number }[]>(
    `SELECT id FROM document_lots
      WHERE notification_state = 'awaiting' AND created_at < $1::timestamptz - make_interval(secs => $2)
      ORDER BY created_at LIMIT $3`,
    [now.toISOString(), Math.round((opts.minAgeMs ?? 15 * 60_000) / 1000), opts.limit ?? 200] as never[]);
  let notified = 0;
  for (const l of lots) if ((await evaluateLotNotification(l.id)) === 'notified') notified += 1;
  return { evaluated: lots.length, notified, expired: expired.length };
}

/**
 * Fin d'une exécution du pipeline : réévalue le lot qu'elle a ouvert (et le
 * lot d'origine d'un document repris). NE LÈVE JAMAIS : l'analyse est
 * terminée et ses résultats sont écrits — une notification différée est un
 * désagrément, une analyse perdue une régression.
 */
export async function notifyLotCompleted(input: LotNotificationInput): Promise<void> {
  // Mascotte d'accueil : l'analyse terminée change la prise de parole du
  // compte ; elle est préparée en arrière-plan (CDC Mascotte RUN-007).
  void import('@/services/home/mascot/mascot.service')
    .then((m) => m.scheduleMascotPregeneration(input.accountId))
    .catch(() => {});

  await evaluateLotNotification(input.lotId, { retryExpected: new Set(input.retryExpectedSourceIds ?? []) });
}
