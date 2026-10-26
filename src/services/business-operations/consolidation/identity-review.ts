/**
 * Lot 78A — CORRECTION RÉTROACTIVE de l'identité économique des Opérations
 * (ticket « [P1] Opérations & TCO », §5 ; traçabilité §6).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN SECOND MOTEUR : LA FILE T3, LA DÉCISION T3, LA RECONSOLIDATION T3
 *
 *   · DÉTECTION (`requestIdentityReview`, appelée par chaque passage T3 du
 *     compte, bornée) : candidats T1 actifs déjà consolidés, pas encore
 *     réévalués par la version `IDENTITY_REVIEW_VERSION` du contrôle, dont
 *     l'Opération porte d'AUTRES sources gérées (regroupement possible) ou
 *     dont le document a un autre candidat sur une autre Opération (doublon
 *     possible) → remis en consolidation (`t3_pending`). Les autres sont
 *     seulement estampillés (aucune écriture métier). Le balayage horaire
 *     prend les comptes concernés (`IDENTITY_REVIEW_PENDING_SQL`) : rattrapage
 *     AUTOMATIQUE du stock, sans action de l'exploitant.
 *   · RÉEXAMEN (`consolidateDocument`) : la décision T3 réévalue la
 *     continuité de chaque source face aux autres sources de son Opération
 *     (`reviewExistingAttachment`) :
 *       – contradiction CERTAINE face à la source fondatrice → la source est
 *         retirée de l'Opération (désactivée, jamais supprimée, motif
 *         `T3_IDENTITY_SEPARATED`) puis décidée comme un nouveau document
 *         (rapprochement contrôlé, création ou attente) ;
 *       – doute → la source RESTE, l'anomalie est signalée (SUSPECT) ;
 *       – rattachement décidé par l'IA (M3) ou l'utilisateur (M0) : jamais
 *         défait automatiquement ;
 *       – doublon d'un même document (description identique) → la source
 *         rejoint l'Opération la plus ancienne ; l'autre, sans source, est
 *         invalidée (réactivable), jamais fusionnée.
 *   · RECALCUL : chaque Opération touchée est reconsolidée depuis ses sources
 *     actives (composantes, dates, prestataire et libellé justifiés par une
 *     source retirée, provenance) ; les événements Opération publiés après
 *     commit mettent à jour l'Agenda (projection et consolidation 76H).
 *   · JOURNAL (`business_operation_identity_reviews`, 0609) : chaque
 *     séparation, doute ou doublon, son motif, ses signaux, sa source et son
 *     Opération d'arrivée — consultable au BO et dans l'export de diagnostic.
 *   · RÉVERSIBLE (`revertIdentitySeparation`, BO) : une séparation se
 *     rétablit par une décision de rapprochement CONFIRMED (origine
 *     ADMIN_REVIEW) — prioritaire (M0) sur toute règle, tracée, durable.
 *
 * Sécurité : requêtes bornées par `account_id` ; aucune suppression de
 * justificatif (sources désactivées, composantes supersédées) ; une
 * correction de l'utilisateur (fiche, agenda, montant ou devise retenus,
 * décisions de rapprochement) n'est jamais écrasée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from 'drizzle-orm';
import type { DbTx } from '../lock';
import type { CandidateDecision, IdentityCheck } from './matching';
import {
  RESTORE_AUDIT_ACTION, RESTORE_AUDIT_TARGET, RESTORE_BLOCK_MESSAGES, type RestoreBlockCode,
} from '../identity-restore.model';

/** Version du contrôle d'identité économique (changer de version relance la réévaluation du stock). */
export const IDENTITY_REVIEW_VERSION = 'l78a-v1';
/** Candidats remis en consolidation au plus par passage (le reste aux passages suivants). */
const IDENTITY_REVIEW_MARK_LIMIT = 100;
/** Candidats examinés (estampillés ou remis) au plus par passage. */
const IDENTITY_REVIEW_SCAN_LIMIT = 2_000;

type Row = Record<string, unknown>;
const rows = async <T = Row>(tx: DbTx, q: SQL): Promise<T[]> => (await tx.execute(q)) as unknown as T[];

/**
 * Prédicat SQL (alias `c`) : candidat actif, établi, pas encore réévalué par
 * cette version du contrôle. Même littéral que l'index partiel 0609_idx_3. Une erreur technique
 * suit SA reprise bornée (lot 54D) : sa trace est réécrite par cette reprise.
 */
export const IDENTITY_REVIEW_PENDING_SQL = `(c.status = 'ACTIVE' AND c.established AND COALESCE(c.t3_detail->>'identityReview', '') <> '${IDENTITY_REVIEW_VERSION}' AND NOT c.t3_pending
  AND COALESCE(c.t3_reason, '') NOT LIKE 'TECHNICAL_ERROR:%')`;

/** Ligne du journal à écrire après une décision T3 (une par contrôle notable). */
export interface IdentityReviewEntry {
  kind: 'SEPARATED' | 'SUSPECT' | 'DUPLICATE_RELOCATED';
  check: IdentityCheck;
  fileId: number;
  candidateKey: string;
  sourceId: number | null;
  decision: CandidateDecision;
}

let journalPret: boolean | null = null;
/** Journal 0609 présent ? (absent : contrôles appliqués, journal non écrit). */
async function identityJournalReady(tx: DbTx): Promise<boolean> {
  if (journalPret) return true;
  const [r] = await rows<{ ok: boolean }>(tx, sql`SELECT to_regclass('business_operation_identity_reviews') IS NOT NULL AS ok`);
  journalPret = !!r?.ok;
  return journalPret;
}

/**
 * Journal des contrôles d'un document (dans la transaction de sa
 * consolidation). Idempotent : une entrée identique n'est pas réécrite ; un
 * doute qui ne se constate plus est RÉSOLU (horodaté), jamais effacé.
 */
export async function recordIdentityReviews(
  tx: DbTx, accountId: number, fileId: number, entries: readonly IdentityReviewEntry[], candidateKeys: readonly string[], correlationId: string | null,
): Promise<void> {
  if (!(await identityJournalReady(tx))) return;
  const ouvertes = await rows<{ id: string; kind: string; operation_id: string; candidate_key: string | null; status: string; signals: unknown; target_operation_id: string | null; source_id: string | null }>(tx, sql`
    SELECT id, kind, operation_id, candidate_key, status, signals, target_operation_id, source_id FROM business_operation_identity_reviews
     WHERE account_id = ${accountId} AND file_id = ${fileId} AND status IN ('OPEN', 'APPLIED') ORDER BY id`);
  const vues = new Set<string>();
  for (const e of entries) {
    const cle = `${e.kind}|${e.check.operationId}|${e.candidateKey}`;
    if (vues.has(cle)) continue;
    vues.add(cle);
    const statut = e.kind === 'SUSPECT' ? 'OPEN' : 'APPLIED';
    const cible = e.kind === 'SUSPECT' ? e.check.operationId : e.decision.operationId;
    const signaux = JSON.stringify(e.check.signals);
    const deja = ouvertes.find((x) => x.kind === e.kind && Number(x.operation_id) === e.check.operationId && x.candidate_key === e.candidateKey);
    if (deja) {
      // Une séparation déjà appliquée reste telle quelle (la source a quitté l'Opération).
      if (e.kind !== 'SUSPECT' || (JSON.stringify(deja.signals) === signaux && (deja.target_operation_id === null ? null : Number(deja.target_operation_id)) === cible)) continue;
      await tx.execute(sql`
        UPDATE business_operation_identity_reviews SET signals = ${signaux}::jsonb, target_operation_id = ${cible},
               against_source_ids = ${`{${(e.check.againstSourceIds ?? []).join(',')}}`}::bigint[], updated_at = now()
         WHERE id = ${Number(deja.id)}`);
      continue;
    }
    await tx.execute(sql`
      INSERT INTO business_operation_identity_reviews
        (account_id, operation_id, kind, status, file_id, candidate_key, source_id, target_operation_id, basis, signals,
         against_source_ids, review_version, correlation_id)
      SELECT ${accountId}, ${e.check.operationId}, ${e.kind}, ${statut}, ${fileId}, ${e.candidateKey}, ${e.sourceId}, ${cible}, ${e.check.basis},
             ${signaux}::jsonb, ${`{${(e.check.againstSourceIds ?? []).join(',')}}`}::bigint[], ${IDENTITY_REVIEW_VERSION}, ${correlationId}
       WHERE EXISTS (SELECT 1 FROM business_operations WHERE id = ${e.check.operationId} AND account_id = ${accountId})`);
  }
  // Doutes du document qui ne se constatent plus (candidat réexaminé, ou disparu) : résolus.
  for (const x of ouvertes.filter((o) => o.kind === 'SUSPECT' && o.status === 'OPEN')) {
    if (vues.has(`SUSPECT|${Number(x.operation_id)}|${x.candidate_key}`)) continue;
    // Le document entier vient d'être réexaminé (`candidateKeys` : ses candidats actifs).
    void candidateKeys;
    await tx.execute(sql`UPDATE business_operation_identity_reviews SET status = 'RESOLVED', resolved_at = now(), updated_at = now() WHERE id = ${Number(x.id)}`);
  }
}

/**
 * Détection bornée du stock (voir l'en-tête) : remet en consolidation les
 * candidats dont le rattachement doit être réévalué, estampille les autres.
 * Rend les documents remis et s'il en reste à examiner. Aucune écriture métier.
 */
export async function requestIdentityReview(
  accountId: number, opts: { markLimit?: number; scanLimit?: number } = {},
): Promise<{ fileIds: number[]; remaining: boolean }> {
  const { pgClient } = await import('@/db');
  const scan = opts.scanLimit ?? IDENTITY_REVIEW_SCAN_LIMIT;
  const mark = opts.markLimit ?? IDENTITY_REVIEW_MARK_LIMIT;
  const r = (await pgClient.unsafe(
    `WITH examines AS (
       SELECT c.id, c.file_id, c.candidate_key, c.t3_operation_id, c.t3_reason FROM document_operation_candidates c
        WHERE c.account_id = $1 AND ${IDENTITY_REVIEW_PENDING_SQL}
        ORDER BY c.id LIMIT $2
     ), eligibles AS (
       SELECT e.id FROM examines e
        WHERE (EXISTS (
                SELECT 1 FROM business_operation_sources s
                  JOIN business_operation_sources s2 ON s2.operation_id = s.operation_id AND s2.account_id = s.account_id AND s2.active AND s2.id <> s.id
                       AND ((s2.source_kind = 'DOCUMENT' AND s2.locator ? 'candidateKey') OR (s2.source_kind = 'ASSET_DATA' AND s2.locator ? 'nature'))
                 WHERE s.account_id = $1 AND s.active AND s.source_kind = 'DOCUMENT'
                   AND s.source_entity_key = e.file_id::text AND s.locator->>'candidateKey' = e.candidate_key)
           OR (e.t3_operation_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM document_operation_candidates o
                 WHERE o.account_id = $1 AND o.file_id = e.file_id AND o.id <> e.id AND o.status = 'ACTIVE' AND o.established
                   AND o.t3_operation_id IS NOT NULL AND o.t3_operation_id <> e.t3_operation_id)))
        ORDER BY e.id LIMIT $3
     ), marques AS (
       UPDATE document_operation_candidates c
          SET t3_pending = true,
              t3_detail = COALESCE(c.t3_detail, '{}'::jsonb) || jsonb_build_object('identityReviewRequested', jsonb_build_object('version', $4::text, 'at', now()))
         FROM eligibles k WHERE c.id = k.id AND c.account_id = $1
       RETURNING c.file_id
     ), estampilles AS (
       UPDATE document_operation_candidates c
          SET t3_detail = COALESCE(c.t3_detail, '{}'::jsonb) || jsonb_build_object('identityReview', $4::text)
         FROM examines e
        WHERE c.id = e.id AND c.account_id = $1
          AND NOT EXISTS (SELECT 1 FROM eligibles k WHERE k.id = e.id)
          AND NOT EXISTS (SELECT 1 FROM examines e2 WHERE e2.file_id = e.file_id AND EXISTS (SELECT 1 FROM eligibles k2 WHERE k2.id = e2.id))
       RETURNING c.id
     )
     SELECT (SELECT array_agg(DISTINCT file_id) FROM marques) AS files,
            (SELECT count(*) FROM examines)::int AS examined,
            (SELECT count(*) FROM eligibles)::int AS eligible`,
    [accountId, scan, mark, IDENTITY_REVIEW_VERSION] as never[],
  )) as unknown as Array<{ files: number[] | null; examined: number; eligible: number }>;
  const x = r[0];
  const fileIds = [...new Set((x?.files ?? []).map(Number))].sort((a, b) => a - b);
  return { fileIds, remaining: Number(x?.examined ?? 0) >= scan || Number(x?.eligible ?? 0) >= mark };
}

/**
 * Documents dont un doute d'identité est OUVERT sur une Opération qui vient de
 * changer (séparation d'une autre source, recalcul) : réexaminés une fois de
 * plus dans le même passage — le doute se résout ou se confirme.
 */
export async function listOpenSuspectFiles(accountId: number, operationIds: readonly number[], limit = 50): Promise<number[]> {
  const ids = [...new Set(operationIds)].filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!ids.length) return [];
  const { pgClient } = await import('@/db');
  try {
    const r = (await pgClient.unsafe(
      `SELECT DISTINCT file_id FROM business_operation_identity_reviews
        WHERE account_id = $1 AND kind = 'SUSPECT' AND status = 'OPEN' AND file_id IS NOT NULL AND operation_id = ANY($2::bigint[])
        ORDER BY file_id LIMIT $3`,
      [accountId, `{${ids.join(',')}}`, limit] as never[],
    )) as unknown as Array<{ file_id: number }>;
    return r.map((y) => Number(y.file_id));
  } catch {
    return [];
  }
}

/**
 * Lot 79A : pourquoi une séparation n'est plus rétablissable (alias `r` =
 * journal, `o` = Opération d'origine jointe sur `(r.operation_id, r.account_id)`) ;
 * NULL = séparation encore effective. MÊME prédicat pour le bouton du détail
 * BO (lecture seule) et pour le contrôle sous verrou du rétablissement.
 */
export const RESTORE_BLOCK_SQL = `(CASE
  WHEN r.kind <> 'SEPARATED' THEN 'NOT_A_SEPARATION'
  WHEN r.status = 'REVERTED' THEN 'ALREADY_RESTORED'
  WHEN r.status <> 'APPLIED' THEN 'NOT_A_SEPARATION'
  WHEN r.file_id IS NULL OR NOT EXISTS (SELECT 1 FROM asset_files f WHERE f.id = r.file_id AND f.account_id = r.account_id AND f.deleted_at IS NULL) THEN 'SOURCE_DELETED'
  WHEN r.candidate_key IS NULL OR NOT EXISTS (SELECT 1 FROM document_operation_candidates c WHERE c.account_id = r.account_id AND c.file_id = r.file_id
                                                AND c.candidate_key = r.candidate_key AND c.status = 'ACTIVE') THEN 'CANDIDATE_GONE'
  WHEN o.merged_into_operation_id IS NOT NULL THEN 'ORIGIN_MERGED'
  WHEN o.invalidated_at IS NOT NULL THEN 'ORIGIN_INVALIDATED'
  WHEN EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.account_id = r.account_id AND s.operation_id = r.operation_id AND s.active
                 AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = r.file_id::text AND s.locator->>'candidateKey' = r.candidate_key) THEN 'ALREADY_ATTACHED'
END)`;

/** Refus d'un rétablissement (lot 79A) : la séparation n'existe pas ou n'est plus effective. */
export class IdentityRestoreRefusedError extends Error {
  constructor(readonly reviewId: number, readonly code: RestoreBlockCode) {
    super(RESTORE_BLOCK_MESSAGES[code]);
    this.name = 'IdentityRestoreRefusedError';
  }
}

/** Contrôle introuvable (pour ce compte / cette Opération) ou non rétablissable — compatibilité lot 78A. */
class IdentityReviewNotFoundError extends IdentityRestoreRefusedError {
  constructor(reviewId: number) {
    super(reviewId, 'NOT_FOUND');
    this.message = `Contrôle d'identité ${reviewId} introuvable ou non rétablissable.`;
    this.name = 'IdentityReviewNotFoundError';
  }
}

interface RevertOptions {
  adminId: number;
  /** E-mail de l'administrateur (journal d'audit ; relu en base si absent). */
  adminEmail?: string;
  /** Lot 79A : compte attendu (contrôle d'appartenance) — refus NOT_FOUND s'il diffère. */
  accountId?: number;
  /** Lot 79A : Opération affichée au BO — la séparation doit la concerner (origine ou arrivée). */
  operationId?: number;
  /** Lot 79A : motif (journal d'audit `OPERATION_IDENTITY_RESTORE`, écrit dans la MÊME transaction). */
  reason?: string;
}

interface RevertResult {
  accountId: number; operationId: number; fileId: number; jobId: number | null;
  before: Record<string, unknown>; after: Record<string, unknown>;
}

/**
 * Rétablit un rattachement séparé (BO, réversibilité §5 ; bouton lot 79A) :
 * décision de rapprochement CONFIRMED (origine ADMIN_REVIEW) du candidat vers
 * son Opération d'origine — prioritaire (M0) au passage T3 suivant, demandé
 * aussitôt. Journal REVERTED, administrateur tracé. Rien n'est édité à la main :
 * le moteur T3 réapplique la décision.
 *
 * Lot 79A : sous le verrou Opérations du compte et `FOR UPDATE` du journal —
 * un double clic ou deux administrateurs ne rétablissent qu'UNE fois (le
 * second reçoit ALREADY_RESTORED) ; refus explicite si la séparation n'est
 * plus effective (`RESTORE_BLOCK_SQL`) ; journal d'audit admin écrit dans la
 * même transaction (atomique avec la décision).
 */
export async function revertIdentitySeparation(reviewId: number, opts: RevertOptions): Promise<RevertResult> {
  if (!Number.isSafeInteger(reviewId) || reviewId <= 0) throw new IdentityReviewNotFoundError(reviewId);
  const { pgClient } = await import('@/db');
  const [pre] = (await pgClient.unsafe(
    `SELECT account_id, operation_id, target_operation_id FROM business_operation_identity_reviews WHERE id = $1`,
    [reviewId] as never[],
  )) as unknown as Array<{ account_id: number; operation_id: string; target_operation_id: string | null }>;
  if (!pre) throw new IdentityReviewNotFoundError(reviewId);
  const accountId = Number(pre.account_id);
  if (opts.accountId !== undefined && opts.accountId !== accountId) throw new IdentityReviewNotFoundError(reviewId);
  if (opts.operationId !== undefined) {
    // L'Opération affichée doit appartenir au compte de la séparation ET la concerner (origine ou arrivée).
    if (opts.operationId !== Number(pre.operation_id) && opts.operationId !== Number(pre.target_operation_id ?? 0)) throw new IdentityReviewNotFoundError(reviewId);
    const [op] = (await pgClient.unsafe(`SELECT 1 AS ok FROM business_operations WHERE id = $1 AND account_id = $2`, [opts.operationId, accountId] as never[])) as unknown as unknown[];
    if (!op) throw new IdentityReviewNotFoundError(reviewId);
  }
  const correlationId = `bo-identity-revert:${reviewId}:${opts.adminId}`;
  const { withBusinessOperationWrite } = await import('../write');
  const done = await withBusinessOperationWrite(accountId, async (repo, session) => {
    // Verrou du compte pris (session) ; la ligne du journal est relue verrouillée : décision unique.
    const [row] = await rows<{ kind: string; status: string; operation_id: string; target_operation_id: string | null; file_id: number | null; candidate_key: string | null;
      candidate_operation_id: string | null; candidate_outcome: string | null; bloque: RestoreBlockCode | null }>(session.tx, sql`
      SELECT r.kind, r.status, r.operation_id, r.target_operation_id, r.file_id, r.candidate_key,
             (SELECT c.t3_operation_id FROM document_operation_candidates c WHERE c.account_id = r.account_id AND c.file_id = r.file_id
                AND c.candidate_key = r.candidate_key AND c.status = 'ACTIVE' ORDER BY c.id DESC LIMIT 1) AS candidate_operation_id,
             (SELECT c.t3_outcome FROM document_operation_candidates c WHERE c.account_id = r.account_id AND c.file_id = r.file_id
                AND c.candidate_key = r.candidate_key AND c.status = 'ACTIVE' ORDER BY c.id DESC LIMIT 1) AS candidate_outcome,
             ${sql.raw(RESTORE_BLOCK_SQL)} AS bloque
        FROM business_operation_identity_reviews r
        JOIN business_operations o ON o.id = r.operation_id AND o.account_id = r.account_id
       WHERE r.id = ${reviewId} AND r.account_id = ${accountId}
         FOR UPDATE OF r`);
    if (!row) throw new IdentityReviewNotFoundError(reviewId);
    if (row.bloque) throw new IdentityRestoreRefusedError(reviewId, row.bloque);
    const operationId = Number(row.operation_id);
    const fileId = Number(row.file_id);
    const candidateKey = String(row.candidate_key);
    const before = {
      reviewStatus: row.status, operationId, targetOperationId: row.target_operation_id === null ? null : Number(row.target_operation_id),
      fileId, candidateKey, candidateOperationId: row.candidate_operation_id === null ? null : Number(row.candidate_operation_id),
      candidateOutcome: row.candidate_outcome,
    };
    const decisionId = await repo.recordMatchDecision({
      sourceKind: 'DOCUMENT', entityKey: fileId, sourceVersion: candidateKey, operationId,
      decision: 'CONFIRMED', origin: 'ADMIN_REVIEW', reasonCode: 'ADMIN_IDENTITY_SEPARATION_REVERTED',
    });
    await session.tx.execute(sql`
      UPDATE business_operation_identity_reviews SET status = 'REVERTED', resolved_at = now(), updated_at = now(), resolved_by_admin_id = ${opts.adminId}
       WHERE id = ${reviewId} AND account_id = ${accountId}`);
    await session.tx.execute(sql`
      UPDATE document_operation_candidates SET t3_pending = true
       WHERE account_id = ${accountId} AND file_id = ${fileId} AND status = 'ACTIVE' AND candidate_key = ${candidateKey}`);
    const after = { reviewStatus: 'REVERTED', matchDecisionId: decisionId, decision: 'CONFIRMED', origin: 'ADMIN_REVIEW', operationId, fileId, candidateKey };
    if (opts.reason !== undefined) {
      const { logAdminAction } = await import('@/lib/admin-audit');
      await logAdminAction({
        adminId: opts.adminId, adminEmail: opts.adminEmail, action: RESTORE_AUDIT_ACTION, targetType: RESTORE_AUDIT_TARGET, targetId: reviewId,
        result: 'SUCCESS', before, after,
        details: { reason: opts.reason, accountId, operationId, viewedOperationId: opts.operationId ?? null, reviewId, correlationId },
        executor: session.tx as never,
      });
    }
    return { operationId, fileId, before, after };
  }, { correlationId });
  const { requestOperationsConsolidation } = await import('./queue');
  // Même périmètre qu'un arbitrage résolu (TRG-018) ; déclencheur inactif : le balayage horaire reprend le candidat en attente.
  const jobId = await requestOperationsConsolidation(accountId, { trigger: 'arbitration_resolved', fileId: done.fileId, correlationId });
  return { accountId, operationId: done.operationId, fileId: done.fileId, jobId, before: done.before, after: { ...done.after, jobId } };
}

/**
 * Lot 79A : sources ACTIVES des Opérations `operationIds` rattachées par une
 * décision de rapprochement CONFIRMED d'origine ADMIN_REVIEW (rétablissement
 * BO). Un administrateur a tranché : ces sources ne sont plus des indices
 * CONTRE l'identité des autres sources de l'Opération (aucun doute ni
 * contradiction d'attribut ré-ouvert par elles).
 */
export async function loadAdminRestoredSourceIds(tx: DbTx, accountId: number, operationIds: readonly number[]): Promise<Set<number>> {
  const ids = [...new Set(operationIds)].filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!ids.length) return new Set();
  const r = await rows<{ id: string }>(tx, sql`
    SELECT s.id FROM business_operation_sources s
     WHERE s.account_id = ${accountId} AND s.active AND s.source_kind = 'DOCUMENT' AND s.operation_id = ANY(${`{${ids.join(',')}}`}::bigint[])
       AND EXISTS (SELECT 1 FROM business_operation_match_decisions d
                    WHERE d.account_id = s.account_id AND d.active AND d.decision = 'CONFIRMED' AND d.origin = 'ADMIN_REVIEW'
                      AND d.candidate_operation_id = s.operation_id AND d.source_kind = 'DOCUMENT'
                      AND d.source_entity_key = s.source_entity_key AND d.source_version = s.locator->>'candidateKey')`);
  return new Set(r.map((x) => Number(x.id)));
}

/**
 * Lot 79A (pur) : une contradiction d'attribut est ARBITRÉE quand, sans les
 * sources rétablies par un administrateur, il ne reste qu'une valeur — elle
 * est conservée à part (traçabilité), hors des contradictions à examiner.
 */
export function splitArbitratedConflicts<C extends { values: Array<{ value: string; sourceIds: number[] }> }>(
  conflicts: readonly C[], adminSourceIds: ReadonlySet<number>,
): { open: C[]; arbitrated: C[] } {
  const open: C[] = [];
  const arbitrated: C[] = [];
  for (const c of conflicts) {
    const restantes = c.values.filter((v) => v.sourceIds.some((id) => !adminSourceIds.has(id)));
    (adminSourceIds.size && restantes.length <= 1 ? arbitrated : open).push(c);
  }
  return { open, arbitrated };
}
