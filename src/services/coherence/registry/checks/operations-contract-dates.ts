/**
 * COH-OPS-CONTRACT-DATES — dates contractuelles issues de périodes facturées
 * (lot 86C, ticket P1 « fausses dates de fin » ; CDC cohérence §4.3, §4.5 ;
 * arbitrages C-Q2, C-Q10, C-Q11).
 *
 * Objet : Opération active de relation durable (contrat, financement) qui
 * porte une date d'effet ou de fin (Opération ou détails contractuels).
 *   · inspection (lecture seule, sans IA) : dates RECALCULÉES par le modèle
 *     de consolidation T3 en simulation (`previewContractDates`, transaction
 *     annulée — seules les sources contractuelles datent un contrat) ; une
 *     date enregistrée que plus aucune source contractuelle ne justifie (fin
 *     de la dernière période facturée prise pour une fin de contrat, source
 *     retirée) → REPAIRABLE `CONTRACT_DATE_UNPROVEN` ; une date établie mais
 *     non reportée → REPAIRABLE `CONTRACT_DATE_STALE` ;
 *   · réparation : `reconsolidateOperations` (consolidation T3 de
 *     l'Opération : dates et détails recalculés, motif
 *     `T3_CONTRACT_DATES_UNPROVEN` dans l'historique, avant / après) puis
 *     `projectAccountOperations` (projection Agenda existante : l'échéance
 *     « Fin de contrat » devenue injustifiée est retirée — trace restaurable
 *     —, un élément touché par l'utilisateur est conservé ; T6, l'accueil et
 *     l'assistant lisent l'Agenda et l'Opération corrigés). Aucune écriture
 *     du contrôle, aucune carte, aucune IA ; recontrôle par le moteur.
 * Aucune règle recopiée : la règle est `contractualDateSource` (model.ts),
 * appliquée par `consolidateOperationState`.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

const OPERATION_CHANGED = 'BUSINESS_OPERATION_CHANGED';

/** Relations durables actives du compte qui portent une date d'effet ou de fin. */
const DATEES_SQL = `o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
  AND o.type_code IN ('CONTRACT', 'FINANCING')
  AND (o.start_date IS NOT NULL OR o.end_date IS NOT NULL
       OR EXISTS (SELECT 1 FROM business_operation_contract_details cd WHERE cd.operation_id = o.id AND (cd.effective_from IS NOT NULL OR cd.effective_to IS NOT NULL))
       OR EXISTS (SELECT 1 FROM business_operation_financing_details fd WHERE fd.operation_id = o.id AND (fd.effective_from IS NOT NULL OR fd.effective_to IS NOT NULL))
       OR EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.active AND s.source_kind = 'DOCUMENT'))`;

export const operationsContractDatesCheck: CoherenceCheck = {
  id: 'COH-OPS-CONTRACT-DATES',
  version: 1,
  status: 'ACTIVE',
  title: 'Opérations : dates de contrat justifiées par une pièce contractuelle (jamais une période facturée)',
  domain: 'operations',
  level: 'N2',
  objectType: 'business_operation',
  scope: 'Opérations actives de type contrat ou financement portant une date d’effet ou de fin',
  sources: ['business_operations', 'business_operation_contract_details', 'business_operation_financing_details', 'business_operation_sources',
    'document_operation_candidates', 'agenda_items'],
  applicability: 'compte éligible (actif et modifiable) ; relation durable consolidée par T3',
  invariant: 'une date d’effet, de fin, de résiliation ou de renouvellement d’un contrat repose sur une source dont la signification contractuelle est établie ; une période facturée ne date jamais un contrat',
  anomalies: ['CONTRACT_DATE_UNPROVEN', 'CONTRACT_DATE_STALE'],
  autoRepairWhen: 'les dates recalculées par le modèle de consolidation T3 (simulation, sans IA) diffèrent des dates enregistrées',
  forbiddenRepairs: ['écrire une date depuis le contrôle', 'inventer une date de fin', 'modifier un élément d’agenda touché par l’utilisateur',
    'recalculer les dates d’une Opération portant des sources non gérées par T3', 'appeler l’IA', 'créer une carte « À traiter »'],
  services: ['business-operations/consolidation/consolidator#previewContractDates', 'business-operations/consolidation/consolidator#reconsolidateOperations',
    'business-operations/agenda-projection/service#projectAccountOperations'],
  chain: ['T1', 'T3', 'PERSISTENCE', 'PROJECTION'],
  triggers: ['SOURCE_ANALYZED', OPERATION_CHANGED],
  frequency: 'campagne exhaustive quotidienne (toutes les relations durables, y compris inchangées) + contrôle ciblé à chaque analyse ou écriture d’Opération',
  criticality: 'HIGH',
  tests: ['L86C-U-DATES', 'L86C-E2E-06', 'L86C-E2E-08'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `SELECT o.id FROM business_operations o WHERE ${DATEES_SQL} AND o.id > $2 ORDER BY o.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    if (e.type === OPERATION_CHANGED) {
      return idsOf(await rows(ctx.sql, `SELECT o.id FROM business_operations o WHERE ${DATEES_SQL} AND o.id = $2`, [accountId, e.entityId]));
    }
    return idsOf(await rows(ctx.sql, `
      SELECT DISTINCT o.id FROM business_operations o
        JOIN business_operation_sources s ON s.operation_id = o.id AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = $2::text
       WHERE ${DATEES_SQL} ORDER BY o.id`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const vivantes = new Set(idsOf(await rows(ctx.sql, `SELECT o.id FROM business_operations o WHERE ${DATEES_SQL} AND o.id = ANY($2::bigint[])`, [accountId, intArray(ids)])));
    const { previewContractDates } = await import('@/services/business-operations/consolidation/consolidator');
    const ecarts = await previewContractDates(accountId, ids.filter((id) => vivantes.has(id)), ctx.today);
    for (const id of ids) {
      if (!vivantes.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      const p = ecarts.get(id);
      if (!p) { out.set(id, { verdict: 'CONSISTENT' }); continue; }
      out.set(id, {
        verdict: 'REPAIRABLE', anomaly: p.unproven ? 'CONTRACT_DATE_UNPROVEN' : 'CONTRACT_DATE_STALE', faultyLink: 'T3',
        expected: p.expected, observed: p.stored,
        detail: { typeCode: p.typeCode, fields: p.fields, repairChain: 'consolidation T3 de l’Opération puis projection Agenda (échéance injustifiée retirée, trace restaurable)' },
        inputHash: hashOf({ id, p }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const [{ reconsolidateOperations }, { projectAccountOperations }] = await Promise.all([
      import('@/services/business-operations/consolidation/consolidator'), import('@/services/business-operations/agenda-projection/service'),
    ]);
    for (const { id } of items) {
      const changes = await reconsolidateOperations(accountId, [id], { today: ctx.today, correlationId: ctx.correlationId });
      // Propagation immédiate à l'Agenda (même moteur que la projection événementielle, idempotent).
      const projection = await projectAccountOperations(accountId, { operationIds: [id], correlationId: ctx.correlationId, today: ctx.today });
      out.set(id, {
        called: true, service: 'reconsolidateOperations+projectAccountOperations', aiCalls: 0,
        result: { changes, projection: { skipped: projection.skipped ?? null } },
        rollbackRef: `business_operation_history:correlation_id=${ctx.correlationId}`,
      });
    }
    return out;
  },
};
