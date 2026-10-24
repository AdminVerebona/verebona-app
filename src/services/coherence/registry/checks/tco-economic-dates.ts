/**
 * COH-TCO-ECONOMIC-DATES — dates économiques injustifiées des composantes
 * financières (lot 86F, ticket P1 « TCO / Opérations : dates économiques
 * injustifiées et leur autoréparation », complément du ticket #559 ;
 * mécanismes des tickets #556 / #562 : registre, campagne quotidienne,
 * contrôles ciblés, réparation par le service métier, recontrôle).
 *
 * Objet : Opération active portant au moins une composante financière active.
 *   · inspection (lecture seule, sans IA) : chaque composante est résolue
 *     par la règle unique (`finance/economic-date` — paiement prouvé, date
 *     propre, justificatif, réalisation d'une Opération ponctuelle à fait
 *     unique ; jamais la date de l'Opération par défaut) et comparée à sa
 *     trace persistée (colonnes 0744) et à l'ancienne règle :
 *       UNJUSTIFIED_ECONOMIC_DATE  l'ancienne règle affectait une autre année
 *                                  (ex. prestations 2026 imputées à 2025 par
 *                                  la date de l'Opération) ;
 *       ECONOMIC_DATE_STALE        trace d'une résolution dépassée (nouvelle
 *                                  preuve, justificatif retiré, règle
 *                                  modifiée) ;
 *       ECONOMIC_DATE_NOT_TRACED   même année, provenance non consignée ;
 *     → REPAIRABLE. Preuves insuffisantes ou contradictoires : la résolution
 *     est UNDETERMINED (incertitude CONSERVÉE, aucune année inventée) et
 *     c'est elle qui est consignée.
 *   · réparation : `applyOperationEconomicDates` (service métier, verrou du
 *     compte, journal `business_operation_history` avant / après) ; le TCO,
 *     T2 et les exports résolvent la même date à la lecture : indicateurs,
 *     détail de l'année et justificatifs sont recalculés d'office. Recontrôle
 *     par le moteur ; second passage : aucune écriture (idempotent).
 * Jamais : écrire `economic_date` (fait T3), toucher une décision « Ajouter /
 * Retirer du TCO », modifier un élément d'agenda, appeler l'IA.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

const OPERATION_CHANGED = 'BUSINESS_OPERATION_CHANGED';

const AVEC_COMPOSANTES_SQL = `
  o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
  AND EXISTS (SELECT 1 FROM business_operation_financial_components c WHERE c.operation_id = o.id AND c.account_id = o.account_id AND c.active)`;

export const tcoEconomicDatesCheck: CoherenceCheck = {
  id: 'COH-TCO-ECONOMIC-DATES',
  version: 1,
  status: 'ACTIVE',
  title: 'TCO : date économique de chaque dépense justifiée par ses preuves',
  domain: 'tco',
  level: 'N2',
  objectType: 'operation',
  scope: 'Opérations actives portant au moins une composante financière active (toutes natures, tout le stock historique)',
  sources: ['business_operations', 'business_operation_financial_components', 'business_operation_financial_component_sources', 'business_operation_sources',
    'asset_files', 'document_operation_candidates', 'business_operation_history'],
  applicability: 'compte éligible (actif et modifiable)',
  invariant: 'la date économique retenue de chaque composante repose sur une preuve (paiement, date propre, justificatif, réalisation d’une dépense ponctuelle unique) dont la provenance est consignée ; sans preuve suffisante, aucune année n’est affectée et la dépense reste dans le TCO cumulatif',
  anomalies: ['UNJUSTIFIED_ECONOMIC_DATE', 'ECONOMIC_DATE_STALE', 'ECONOMIC_DATE_NOT_TRACED'],
  autoRepairWhen: 'toujours : la résolution courante (date établie, ou incertitude conservée) est consignée par le service métier ; le TCO, T2 et les exports la lisent déjà',
  forbiddenRepairs: ['dater une dépense par la date de l’Opération sans justification', 'dater une dépense par le début de la période couverte',
    'réécrire la date propre consolidée par T3', 'supprimer une dépense réalisée', 'modifier une décision « Ajouter / Retirer du TCO »',
    'modifier un élément d’agenda', 'appeler l’IA', 'règle propre à un fournisseur ou à un document'],
  services: ['business-operations/finance/economic-date.service#inspectOperationEconomicDates', 'business-operations/finance/economic-date.service#applyOperationEconomicDates'],
  chain: ['T3', 'PERSISTENCE'],
  triggers: [OPERATION_CHANGED, 'DOCUMENT_UPDATED', 'SOURCE_ANALYZED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque écriture d’Opération, modification ou analyse d’un justificatif',
  criticality: 'HIGH',
  tests: ['L86F-U-01', 'L86F-U-12', 'L86F-E2E-01', 'L86F-E2E-05', 'L86F-E2E-06'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT o.id FROM business_operations o WHERE o.account_id = $1 AND o.id > $2 AND ${AVEC_COMPOSANTES_SQL} ORDER BY o.id LIMIT $3`,
    [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    if (e.type === OPERATION_CHANGED) {
      return idsOf(await rows(ctx.sql, `SELECT o.id FROM business_operations o WHERE o.account_id = $1 AND o.id = $2 AND ${AVEC_COMPOSANTES_SQL}`, [accountId, e.entityId]));
    }
    // Justificatif modifié ou analysé : Opérations dont il est une source active (sa date, ses règlements).
    return idsOf(await rows(ctx.sql, `
      SELECT DISTINCT o.id FROM business_operations o
        JOIN business_operation_sources s ON s.operation_id = o.id AND s.account_id = o.account_id AND s.active AND s.source_kind = 'DOCUMENT'
       WHERE o.account_id = $1 AND s.source_entity_key = $2::text AND ${AVEC_COMPOSANTES_SQL}
       ORDER BY o.id`, [accountId, String(e.entityId)]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { inspectOperationEconomicDates } = await import('@/services/business-operations/finance/economic-date.service');
    const etats = await inspectOperationEconomicDates(accountId, ids);
    const existants = new Set(idsOf(await rows(ctx.sql, `
      SELECT id FROM business_operations WHERE account_id = $1 AND id = ANY($2::bigint[]) AND invalidated_at IS NULL AND merged_into_operation_id IS NULL`,
    [accountId, intArray(ids)])));
    for (const id of ids) {
      const liste = etats.get(id);
      if (!liste) { out.set(id, { verdict: existants.has(id) ? 'CONSISTENT' : 'GONE' }); continue; }
      const ecarts = liste.filter((e) => e.anomaly);
      if (!ecarts.length) { out.set(id, { verdict: 'CONSISTENT', detail: { components: liste.length } }); continue; }
      const anomaly = ecarts.some((e) => e.anomaly === 'UNJUSTIFIED_ECONOMIC_DATE') ? 'UNJUSTIFIED_ECONOMIC_DATE'
        : ecarts.some((e) => e.anomaly === 'ECONOMIC_DATE_STALE') ? 'ECONOMIC_DATE_STALE' : 'ECONOMIC_DATE_NOT_TRACED';
      out.set(id, {
        verdict: 'REPAIRABLE', anomaly, faultyLink: 'PERSISTENCE',
        expected: ecarts.map((e) => ({ componentId: e.componentId, date: e.resolution.date, basis: e.resolution.basis, status: e.resolution.status, reason: e.resolution.reason, provenance: e.resolution.provenance })),
        observed: ecarts.map((e) => ({ componentId: e.componentId, anomaly: e.anomaly, legacyDate: e.legacyDate, persisted: e.persisted })),
        detail: {
          components: liste.length, gaps: ecarts.length,
          undetermined: ecarts.filter((e) => e.resolution.status === 'UNDETERMINED').length,
          repairChain: 'applyOperationEconomicDates (trace et journal) ; TCO, T2 et exports recalculés à la lecture',
        },
        inputHash: hashOf({ id, s: ecarts.map((e) => [e.componentId, e.signature, e.persisted?.signature ?? null]) }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { applyOperationEconomicDates } = await import('@/services/business-operations/finance/economic-date.service');
    for (const { id } of items) {
      const r = await applyOperationEconomicDates(accountId, [id], { correlationId: ctx.correlationId });
      out.set(id, {
        called: true, service: 'applyOperationEconomicDates', aiCalls: 0,
        result: { recorded: r.recorded, unjustifiedFixed: r.unjustifiedFixed, unchanged: r.unchanged, components: r.components.slice(0, 20) },
        rollbackRef: `business_operation_history:correlation_id=${ctx.correlationId}`,
      });
    }
    return out;
  },
};
