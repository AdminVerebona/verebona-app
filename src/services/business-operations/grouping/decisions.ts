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
import { excludeAsset, releaseExclusion } from '../consolidation/asset-exclusions';
import type { DbTx } from '../lock';
import type { DecisionSubject } from './model';
import type { GroupingRunner } from './runner';

export interface GroupingDecisionInput {
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
  return p.decision === 'REJECTED'
    ? excludeAsset(tx, p.accountId, p.operationId, p.assetId, p.userId)
    : releaseExclusion(tx, p.accountId, p.operationId, p.assetId, p.reasonCode);
}
