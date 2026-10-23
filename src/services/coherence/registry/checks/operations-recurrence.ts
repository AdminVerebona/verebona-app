/**
 * COH-OPS-RECURRING-SERIES — factures d'un même service non regroupées
 * (lot 84E ; CDC v5 O-6 §9.1, §9.2, AC45, AC46 ; CDC cohérence §4.3 ;
 * arbitrages C-Q2, C-Q10, C-Q11 ; plan v5 : « la reconsolidation ciblée est
 * la réparation de PREMIER RANG des constats C3 / C4 »).
 *
 * Objet : document récurrent (échéance, ou document de contrat) déjà
 * consolidé dont l'Opération a une voisine du même prestataire.
 *   · inspection (lecture seule, sans IA) : la décision T3 RECALCULÉE en
 *     simulation (`previewSeriesGrouping`, transaction annulée — mêmes règles
 *     que la consolidation : identité de série, contrôle 78A, décisions
 *     utilisateur) dit si le document rejoindrait une autre Opération de sa
 *     série → REPAIRABLE `RECURRING_SERIES_UNGROUPED` ; sinon CONSISTENT
 *     (services distincts, montants contradictoires, refus de l'utilisateur,
 *     ou rapprochement seulement plausible : l'IA M3 du passage T3 et la carte
 *     « À traiter » existantes en restent juges) ;
 *   · réparation : `reconsolidateRecurringDocuments` (reconsolidation ciblée
 *     O-6 : marque de réexamen 55B + consolidation T3 du document, fusion
 *     existante) — aucune écriture du contrôle, aucune IA ; recontrôle par le
 *     moteur.
 * Ne duplique aucun code de 83B ni de 55B : la règle est celle de
 * `consolidation/recurrence.ts`, appliquée par `decideCandidate`.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

const OPERATION_CHANGED = 'BUSINESS_OPERATION_CHANGED';

/**
 * Documents récurrents consolidés du compte dont l'Opération (active, de
 * type compatible) a une voisine active du MÊME prestataire (prédicats 55B,
 * `retro.ts`). Préfiltre de lecture : la décision reste la simulation T3.
 */
async function documentsRecurrents(sql: Parameters<typeof rows>[0], accountId: number, extra: string, params: unknown[]): Promise<number[]> {
  const { RETRO_ELIGIBLE_SQL, RETRO_TYPES_SQL, OWN_OPERATION_SQL } = await import('@/services/business-operations/consolidation/retro');
  return idsOf(await rows(sql, `
    SELECT DISTINCT c.file_id AS id FROM document_operation_candidates c
      JOIN business_operations x ON x.account_id = c.account_id AND x.id = ${OWN_OPERATION_SQL}
      JOIN asset_files f ON f.id = c.file_id AND f.account_id = c.account_id AND f.deleted_at IS NULL
     WHERE c.account_id = $1 AND c.status = 'ACTIVE' AND c.established AND NOT c.t3_pending
       AND c.t3_outcome IN ('CREATE_NEW', 'MATCH_AND_ENRICH')
       AND x.invalidated_at IS NULL AND x.merged_into_operation_id IS NULL AND ${RETRO_TYPES_SQL('x')}
       AND ${RETRO_ELIGIBLE_SQL}
       AND NULLIF(lower(btrim(x.provider)), '') IS NOT NULL
       AND EXISTS (SELECT 1 FROM business_operations y
                    WHERE y.account_id = x.account_id AND y.id <> x.id AND y.invalidated_at IS NULL AND y.merged_into_operation_id IS NULL
                      AND ${RETRO_TYPES_SQL('y')} AND lower(btrim(y.provider)) = lower(btrim(x.provider)))
       ${extra}
     ORDER BY 1`, [accountId, ...params]));
}

export const operationsRecurringSeriesCheck: CoherenceCheck = {
  id: 'COH-OPS-RECURRING-SERIES',
  version: 1,
  status: 'ACTIVE',
  title: 'Opérations : factures d’un même service regroupées (série récurrente, O-6)',
  domain: 'operations',
  level: 'N2',
  objectType: 'document',
  scope: 'documents récurrents consolidés (échéance ou contrat) dont l’Opération a une voisine du même prestataire',
  sources: ['document_operation_candidates', 'business_operations', 'business_operation_sources', 'business_operation_references',
    'business_operation_financial_components', 'business_operation_equipment_links', 'business_operation_match_decisions'],
  applicability: 'compte éligible (actif et modifiable) ; document récurrent déjà consolidé',
  invariant: 'les factures successives d’un même service (même prestataire et clé de service commune : contrat, compte client, équipement) appartiennent à une seule Opération, sauf services distincts, montants contradictoires (78A) ou décision de l’utilisateur',
  anomalies: ['RECURRING_SERIES_UNGROUPED'],
  autoRepairWhen: 'la décision T3 recalculée (simulation, sans IA) réunit le document à sa série établie',
  forbiddenRepairs: ['regrouper sur le seul prestataire', 'regrouper deux contrats distincts', 'défaire une décision de l’utilisateur',
    'regrouper des montants contradictoires (78A)', 'appeler l’IA depuis le contrôle', 'écrire hors de la consolidation T3'],
  services: ['business-operations/consolidation/consolidator#previewSeriesGrouping', 'business-operations/consolidation/targeted#reconsolidateRecurringDocuments'],
  chain: ['T1', 'T3', 'PERSISTENCE'],
  triggers: ['SOURCE_ANALYZED', OPERATION_CHANGED],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque analyse ou écriture d’Opération',
  criticality: 'MEDIUM',
  tests: ['L84E-U-SERIES', 'L84E-E2E-09'],

  async listObjects(ctx, accountId, afterId, limit) {
    const tous = await documentsRecurrents(ctx.sql, accountId, `AND c.file_id > $2`, [afterId]);
    return tous.slice(0, limit);
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    if (e.type === OPERATION_CHANGED) return documentsRecurrents(ctx.sql, accountId, `AND (x.id = $2 OR EXISTS (
      SELECT 1 FROM business_operations z WHERE z.id = $2 AND z.account_id = x.account_id AND lower(btrim(z.provider)) = lower(btrim(x.provider))))`, [e.entityId]);
    return documentsRecurrents(ctx.sql, accountId, `AND c.file_id = $2`, [e.entityId]);
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const vivants = new Set(await documentsRecurrents(ctx.sql, accountId, `AND c.file_id = ANY($2::int[])`, [intArray(ids)]));
    const { previewSeriesGrouping } = await import('@/services/business-operations/consolidation/consolidator');
    const apercu = await previewSeriesGrouping(accountId, ids.filter((id) => vivants.has(id)));
    for (const id of ids) {
      if (!vivants.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      const p = apercu.get(id);
      if (!p) { out.set(id, { verdict: 'CONSISTENT' }); continue; }
      out.set(id, {
        verdict: 'REPAIRABLE', anomaly: 'RECURRING_SERIES_UNGROUPED', faultyLink: 'T3',
        expected: { operationId: p.targetOperationId }, observed: { operationIds: p.operationIds, mergeIds: p.mergeIds },
        detail: { keys: p.keys, repairChain: 'reconsolidation ciblée O-6 (consolidation T3, fusion existante)' },
        inputHash: hashOf({ id, p }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { reconsolidateRecurringDocuments } = await import('@/services/business-operations/consolidation/targeted');
    for (const { id } of items) {
      const r = await reconsolidateRecurringDocuments(accountId, { fileIds: [id] }, { trigger: 'coherence', correlationId: ctx.correlationId, today: ctx.today });
      if (r.errors.length) throw new Error(r.errors.join(' ; ').slice(0, 400));
      out.set(id, {
        called: true, service: 'reconsolidateRecurringDocuments', aiCalls: r.aiCalls,
        result: { marked: r.marked.length, consolidated: r.consolidated, changes: r.changes, operations: r.operations, skipped: r.skipped ?? null },
        rollbackRef: `business_operation_history:correlation_id=${ctx.correlationId}`,
      });
    }
    return out;
  },
};
