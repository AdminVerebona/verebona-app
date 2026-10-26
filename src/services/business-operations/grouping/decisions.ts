/**
 * Mémoire UNIFIÉE des décisions utilisateur de regroupement (lot 82D, CDC v5
 * §10, E18, P8) — RÉUTILISE les supports existants, aucune table nouvelle :
 *
 *   document, élément d'agenda, Pièce, équipement, lien propagé vers le
 *   principal  → `business_operation_match_decisions` (C6.3, lot 42 ; objets
 *                étendus par 0656), CONFIRMED / REJECTED, une décision active
 *                par (Opération, objet), remappée à la fusion (dépôt) ;
 *   bien       → `business_operation_asset_exclusions` (lot 53, Q17) ;
 *   projection supprimée par l'utilisateur → `business_operation_projection_suppressions`
 *                (C16.1), lue par la projection T4.
 *
 * Une décision utilisateur prime sur l'inférence : un rattachement refusé ou
 * dissocié n'est pas recréé au passage suivant sur les mêmes preuves ; un
 * rattachement explicite lève un refus antérieur. Cette mémoire est une
 * responsabilité CODE / données : elle ne dépend d'aucun prompt.
 */
import { sql } from 'drizzle-orm';
import { excludeAsset, releaseExclusion } from '../consolidation/asset-exclusions';
import type { DbTx } from '../lock';
import type { DecisionSubject } from './model';
import type { GroupingRunner } from './runner';

interface GroupingDecisionInput {
  accountId: number;
  operationId: number;
  subject: DecisionSubject;
  entityId: number;
  decision: 'CONFIRMED' | 'REJECTED';
  reasonCode: string;
}

/**
 * Enregistre une décision (idempotent : une décision active identique n'est
 * pas réécrite ; une décision contraire désactive la précédente — jamais
 * effacée). Même règle que `BusinessOperationRepository.recordMatchDecision`.
 */
export async function recordGroupingDecision(r: GroupingRunner, d: GroupingDecisionInput): Promise<boolean> {
  const key = String(d.entityId);
  const [cur] = await r.q<{ id: string; decision: string }>(
    `SELECT id, decision FROM business_operation_match_decisions
      WHERE account_id = $1 AND candidate_operation_id = $2 AND source_kind = $3 AND source_entity_key = $4
        AND source_version IS NULL AND active FOR UPDATE`,
    [d.accountId, d.operationId, d.subject, key],
  );
  if (cur && cur.decision === d.decision) return false;
  if (cur) await r.q(`UPDATE business_operation_match_decisions SET active = false, updated_at = now() WHERE id = $1`, [Number(cur.id)]);
  await r.q(
    `INSERT INTO business_operation_match_decisions
       (account_id, source_kind, source_entity_key, source_version, candidate_operation_id, decision, origin, reason_code)
     VALUES ($1, $2, $3, NULL, $4, $5, 'USER_ARBITRATION', $6)`,
    [d.accountId, d.subject, key, d.operationId, d.decision, d.reasonCode],
  );
  return true;
}

/** Objets REFUSÉS par l'utilisateur pour une Opération (décisions actives). */
export async function rejectedSubjects(r: GroupingRunner, accountId: number, operationId: number, subject: DecisionSubject): Promise<number[]> {
  const x = await r.q<{ k: string }>(
    `SELECT source_entity_key AS k FROM business_operation_match_decisions
      WHERE account_id = $1 AND candidate_operation_id = $2 AND source_kind = $3 AND decision = 'REJECTED' AND active`,
    [accountId, operationId, subject],
  );
  return x.map((y) => Number(y.k)).filter((n) => Number.isSafeInteger(n)).sort((a, b) => a - b);
}

/** L'objet est-il refusé pour cette Opération ? */
export async function isRejected(r: GroupingRunner, accountId: number, operationId: number, subject: DecisionSubject, entityId: number): Promise<boolean> {
  const [x] = await r.q(
    `SELECT 1 FROM business_operation_match_decisions
      WHERE account_id = $1 AND candidate_operation_id = $2 AND source_kind = $3 AND source_entity_key = $4
        AND decision = 'REJECTED' AND active LIMIT 1`,
    [accountId, operationId, subject, String(entityId)],
  );
  return !!x;
}

/** Bien : mémoire d'exclusion existante (0349). */
export async function recordAssetDecision(
  tx: DbTx, p: { accountId: number; operationId: number; assetId: number; decision: 'CONFIRMED' | 'REJECTED'; userId: number | null; reasonCode: string },
): Promise<boolean> {
  if (p.decision !== 'REJECTED') return releaseExclusion(tx, p.accountId, p.operationId, p.assetId, p.reasonCode);
  // Lot 83D (repris du formulaire Sinistre retiré, retour PO Q17) : les documents
  // déjà rattachés à l'Opération sont CONNUS au moment du retrait — ils ne
  // contredisent pas la décision ; seul un NOUVEAU document produit une carte.
  const connus = ((await tx.execute(sql`
    SELECT DISTINCT source_entity_key AS k FROM business_operation_sources
     WHERE operation_id = ${p.operationId} AND account_id = ${p.accountId} AND active AND source_kind = 'DOCUMENT'
       AND source_entity_key ~ '^[0-9]{1,9}$'`)) as unknown as Array<{ k: string }>).map((x) => Number(x.k));
  return excludeAsset(tx, p.accountId, p.operationId, p.assetId, p.userId, connus);
}

/**
 * Lot 84B (CDC v5 §10, §11.9 ; point ouvert 83A) — l'utilisateur a-t-il
 * RETIRÉ le rôle principal dans cette Opération (décision PRINCIPAL REJECTED
 * active, quel que soit l'élément) ? Tant que c'est le cas, aucune inférence
 * n'y désigne ni n'y crée de principal (`mayDesignatePrincipal`).
 */
export async function principalWithdrawnByUser(r: GroupingRunner, accountId: number, operationId: number): Promise<boolean> {
  const [x] = await r.q(
    `SELECT 1 FROM business_operation_match_decisions
      WHERE account_id = $1 AND candidate_operation_id = $2 AND source_kind = 'PRINCIPAL' AND decision = 'REJECTED' AND active LIMIT 1`,
    [accountId, operationId],
  );
  return !!x;
}

/**
 * Nouvelle désignation par l'utilisateur : ses retraits antérieurs du rôle
 * principal dans l'Opération sont levés (désactivés, jamais effacés) — le
 * choix le plus récent de l'utilisateur fait foi. Rend le nombre levé.
 */
export async function liftPrincipalWithdrawals(r: GroupingRunner, accountId: number, operationId: number): Promise<number> {
  return (await r.q(
    `UPDATE business_operation_match_decisions SET active = false, updated_at = now()
      WHERE account_id = $1 AND candidate_operation_id = $2 AND source_kind = 'PRINCIPAL' AND decision = 'REJECTED' AND active
     RETURNING id`,
    [accountId, operationId],
  )).length;
}

// ── Lot 86D : décision de l'utilisateur sur UN lien Document ↔ Agenda ──────

/** Clé de l'objet AGENDA_FILE_LINK (`<agenda_items.id>:<asset_files.id>`). */
const agendaFileLinkKey = (itemId: number, fileId: number): string => `${itemId}:${fileId}`;

/**
 * Fragment SQL : le lien (élément `itemExpr`, document `fileExpr`) a-t-il été
 * DÉTACHÉ par l'utilisateur (décision active) ? Réutilisé par les écrivains
 * SQL de liens (consolidation 76H, reprise) et par les contrôles.
 */
export const linkRejectedSql = (itemExpr: string, fileExpr: string): string =>
  `EXISTS (SELECT 1 FROM business_operation_match_decisions dl
            WHERE dl.source_kind = 'AGENDA_FILE_LINK' AND dl.candidate_operation_id IS NULL AND dl.active AND dl.decision = 'REJECTED'
              AND dl.account_id = (SELECT ai.account_id FROM agenda_items ai WHERE ai.id = ${itemExpr})
              AND dl.source_entity_key = (${itemExpr})::text || ':' || (${fileExpr})::text)`;

/**
 * Enregistre la décision de l'utilisateur sur un lien (idempotent : une
 * décision active identique n'est pas réécrite ; une décision contraire
 * désactive la précédente — jamais effacée). Mémoire unifiée 82D, sans
 * Opération (0736). Appelée sous le verrou 39101 du compte.
 */
export async function recordLinkDecision(
  r: GroupingRunner, d: { accountId: number; itemId: number; fileId: number; decision: 'CONFIRMED' | 'REJECTED'; reasonCode: string },
): Promise<boolean> {
  const key = agendaFileLinkKey(d.itemId, d.fileId);
  const [cur] = await r.q<{ id: string; decision: string }>(
    `SELECT id, decision FROM business_operation_match_decisions
      WHERE account_id = $1 AND source_kind = 'AGENDA_FILE_LINK' AND source_entity_key = $2 AND candidate_operation_id IS NULL AND active FOR UPDATE`,
    [d.accountId, key],
  );
  if (cur && cur.decision === d.decision) return false;
  if (cur) await r.q(`UPDATE business_operation_match_decisions SET active = false, updated_at = now() WHERE id = $1`, [Number(cur.id)]);
  await r.q(
    `INSERT INTO business_operation_match_decisions
       (account_id, source_kind, source_entity_key, source_version, candidate_operation_id, decision, origin, reason_code)
     VALUES ($1, 'AGENDA_FILE_LINK', $2, NULL, NULL, $3, 'USER_ARBITRATION', $4)`,
    [d.accountId, key, d.decision, d.reasonCode],
  );
  return true;
}

/**
 * Lève les détachements actifs de ces liens (rattachement explicite de
 * l'utilisateur par le formulaire de l'élément) — désactivés, jamais effacés.
 */
export async function liftLinkRejections(r: GroupingRunner, accountId: number, itemId: number, fileIds: readonly number[]): Promise<number> {
  const keys = [...new Set(fileIds)].filter((f) => Number.isSafeInteger(f) && f > 0).map((f) => agendaFileLinkKey(itemId, f));
  if (!keys.length) return 0;
  return (await r.q(
    `UPDATE business_operation_match_decisions SET active = false, updated_at = now()
      WHERE account_id = $1 AND source_kind = 'AGENDA_FILE_LINK' AND candidate_operation_id IS NULL AND active AND decision = 'REJECTED'
        AND source_entity_key = ANY($2::text[])
     RETURNING id`,
    // Littéral de tableau PostgreSQL (clés `<entier>:<entier>`, sûres) : un tableau JS serait déplié par Drizzle.
    [accountId, `{${keys.map((k) => `"${k}"`).join(',')}}`],
  )).length;
}

/** Documents dont le lien avec l'élément `itemId` a été détaché par l'utilisateur (décisions actives), parmi `fileIds` (tous si null). */
export async function rejectedLinkFileIds(r: GroupingRunner, itemId: number, fileIds: readonly number[] | null = null): Promise<number[]> {
  const x = await r.q<{ k: string }>(
    `SELECT d.source_entity_key AS k FROM business_operation_match_decisions d JOIN agenda_items i ON i.id = $1 AND i.account_id = d.account_id
      WHERE d.source_kind = 'AGENDA_FILE_LINK' AND d.candidate_operation_id IS NULL AND d.active AND d.decision = 'REJECTED'
        AND d.source_entity_key LIKE $2`,
    [itemId, `${itemId}:%`],
  );
  const set = fileIds === null ? null : new Set(fileIds);
  return x.map((y) => Number(y.k.split(':')[1])).filter((n) => Number.isSafeInteger(n) && (set === null || set.has(n))).sort((a, b) => a - b);
}
