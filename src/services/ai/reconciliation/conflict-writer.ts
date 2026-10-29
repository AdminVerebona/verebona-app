/**
 * Écriture des conflits — CDC §4.2.9 et §5.4.4.
 *
 * « Les contradictions non résolues alimentent la page À traiter, catégorie
 *   À arbitrer. » Critère d'acceptation n°13.
 *
 * REMPLACE le stockage actuel des alertes de cohérence dans le blob JSON
 * `assets.keyCharacteristics.coherenceAlerts`, qui n'était ni requêtable, ni
 * historisable, ni rattachable à une preuve.
 *
 * Chaque conflit référence les preuves des DEUX valeurs : l'utilisateur doit
 * pouvoir ouvrir les documents des deux côtés pour arbitrer.
 */
import { pgClient } from '@/db';
import type { ReconciliationDecision } from './types';
import { reasonLabel } from './decision/reason-codes';
import { getAuthorityMatrix } from './decision/authority-matrix';

interface ConflictContext {
  accountId: number;
  assetId: number;
  currentEvidenceIds: number[];
  currentOrigin: string;
  traceId?: string;
}

/**
 * Crée ou met à jour un conflit ouvert. L'index unique partiel existant
 * (`asset_id, field_key WHERE status='open'`) garantit qu'un même champ ne
 * génère jamais deux arbitrages simultanés — un utilisateur ne doit pas voir
 * deux cartes pour la même contradiction.
 */
export async function writeConflict(
  decision: ReconciliationDecision,
  ctx: ConflictContext,
): Promise<'created' | 'updated' | 'unchanged'> {
  // Lot 99A : un arbitrage ouvert IDENTIQUE (mêmes valeurs, mêmes preuves, même
  // règle, même motif) n'est ni recréé ni réécrit — `updated_at` reste celui de
  // sa dernière modification réelle (passages T3 répétés sans changement).
  const rows = (await pgClient.unsafe(
    `INSERT INTO inconsistency_registry (
       account_id, asset_id, field_key, current_value, proposed_value,
       source_type, source_detail, inconsistency_type, status,
       current_evidence_ids, proposed_evidence_ids,
       authority_rule, decision_mode, reason_code, current_origin, operation_trace_id
     ) VALUES ($1,$2,$3,$4,$5,'reconciliation',$6,$7,'open',
               $8::jsonb,$9::jsonb,$10,$11,$12,$13,$14)
     ON CONFLICT (asset_id, field_key) WHERE status = 'open'
     DO UPDATE SET
       proposed_value = EXCLUDED.proposed_value,
       proposed_evidence_ids = EXCLUDED.proposed_evidence_ids,
       current_evidence_ids = EXCLUDED.current_evidence_ids,
       authority_rule = EXCLUDED.authority_rule,
       reason_code = EXCLUDED.reason_code,
       updated_at = NOW()
     WHERE inconsistency_registry.proposed_value IS DISTINCT FROM EXCLUDED.proposed_value
        OR inconsistency_registry.proposed_evidence_ids IS DISTINCT FROM EXCLUDED.proposed_evidence_ids
        OR inconsistency_registry.current_evidence_ids IS DISTINCT FROM EXCLUDED.current_evidence_ids
        OR inconsistency_registry.authority_rule IS DISTINCT FROM EXCLUDED.authority_rule
        OR inconsistency_registry.reason_code IS DISTINCT FROM EXCLUDED.reason_code
     RETURNING (xmax = 0) AS created`,
    [
      ctx.accountId, ctx.assetId, decision.fieldKey,
      stringify(decision.currentValue), stringify(decision.proposedValue),
      reasonLabel(decision.reasonCode),
      decision.confidence === 'conflictual' ? 'conflictual' : 'probable',
      JSON.stringify(ctx.currentEvidenceIds),
      JSON.stringify(decision.evidenceIds),
      getAuthorityMatrix().version,
      decision.deterministic ? 'deterministic' : 'ai_assisted',
      decision.reasonCode,
      ctx.currentOrigin,
      ctx.traceId ?? null,
    ] as never[],
  )) as unknown as Array<{ created: boolean }>;
  if (!rows[0]) return 'unchanged';
  return rows[0].created ? 'created' : 'updated';
}

/**
 * Ferme un conflit devenu sans objet — par exemple lorsqu'une preuve plus
 * autoritaire arrive et tranche la contradiction. Laisser un arbitrage obsolète
 * dans « À traiter » est aussi pénalisant qu'en oublier un.
 */
export async function resolveObsoleteConflict(
  accountId: number,
  assetId: number,
  fieldKey: string,
  resolution: string,
): Promise<void> {
  await pgClient.unsafe(
    `UPDATE inconsistency_registry
        SET status = 'resolved', resolution = $4, resolved_at = NOW(), updated_at = NOW()
      WHERE account_id = $1 AND asset_id = $2 AND field_key = $3 AND status = 'open'`,
    [accountId, assetId, fieldKey, resolution] as never[],
  );
}

function stringify(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}
