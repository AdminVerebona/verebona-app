/**
 * COH-TCO-COMMERCIAL-ADJUSTMENTS — remises lues comme des avoirs et achats
 * fragmentés déjà PERSISTÉS par T3 (lot 109D, ticket P1 « TCO — remises vs
 * avoirs, 1 document → 1..N achats » §3E). Ajouté EN FIN de registre.
 *
 * Objet : le DOCUMENT dont un candidat T1 actif porte une remise
 * (`REDUCTION` / `REFUND`), plusieurs coûts, ou une commande avec paiement.
 * Le TCO documentaire est repris d'office à la lecture (moteur corrigé) ; ce
 * contrôle répare le stock T3 : composante de faux avoir, source « remise
 * seule », lignes au lieu du net, commande payée restée en prévision →
 * reconsolidation T3 DÉTERMINISTE des Opérations concernées (aucune IA,
 * sources gérées seulement). Une Opération portant une décision de
 * l'utilisateur (montant, devise) n'est jamais réparée : constat. Rejoué :
 * plus aucun écart (idempotent).
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, rows } from '../util';

export const TCO_COMMERCIAL_ADJUSTMENTS_CHECK_ID = 'COH-TCO-COMMERCIAL-ADJUSTMENTS';

/** Documents candidats : remise, plusieurs coûts, ou commande avec paiement, sur un candidat actif. */
const CANDIDATS = (extra: string) => `
  SELECT DISTINCT c.file_id AS id FROM document_operation_candidates c
    JOIN asset_files f ON f.id = c.file_id AND f.account_id = c.account_id AND f.deleted_at IS NULL
   WHERE c.account_id = $1 AND c.status = 'ACTIVE' AND c.established ${extra}
     AND (EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(c.payload->'financialHints', '[]'::jsonb)) h WHERE h->>'role' IN ('REDUCTION', 'REFUND'))
       OR (SELECT count(*) FROM jsonb_array_elements(COALESCE(c.payload->'financialHints', '[]'::jsonb)) h WHERE h->>'role' IN ('REALIZED_COST', 'FORECAST_COST')) >= 2
       OR (c.payload->>'sourceRoleHint' = 'ORDER'
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(c.payload->'financialHints', '[]'::jsonb)) h WHERE h->>'role' = 'PAYMENT')))`;

export const tcoCommercialAdjustmentsCheck: CoherenceCheck = {
  id: TCO_COMMERCIAL_ADJUSTMENTS_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'TCO : une remise n’est jamais un avoir ; un achat = un coût net, sans double déduction',
  domain: 'tco',
  level: 'N2',
  objectType: 'document',
  scope: 'documents du compte dont un candidat T1 actif porte une remise, plusieurs coûts ou une commande avec paiement (stock historique compris)',
  sources: ['asset_files', 'document_operation_candidates', 'business_operations', 'business_operation_sources', 'business_operation_financial_components',
    'business_operation_financial_component_sources'],
  applicability: 'compte éligible (actif) ; candidats T1 persistés (aucune relecture du fichier, aucun appel IA)',
  invariant: 'une remise, un code promo ou une réduction portés par une commande ou une facture sont intégrés au net de l’achat (jamais un avoir ni un remboursement autonome) ; un document produit autant de coûts que d’achats économiquement distincts ; seul un document propre (avoir, preuve de remboursement) réduit le coût d’un achat',
  anomalies: ['FALSE_CREDIT_COMPONENT', 'ADJUSTMENT_ONLY_SOURCE', 'PURCHASE_COMPONENTS_MISMATCH', 'USER_DECISION_PRESERVED'],
  autoRepairWhen: 'composante persistée qu’aucun candidat du document ne justifie plus selon la règle commune (remise lue comme avoir, ligne ou frais au lieu du net, commande payée en prévision), ou source « remise seule » active — sur une Opération sans décision de l’utilisateur',
  forbiddenRepairs: ['modifier une saisie, une décision de montant / devise ou un geste « Ajouter / Retirer du TCO »', 'répartir une remise globale sans règle explicite',
    'supprimer un justificatif ou un candidat T1', 'créer une Opération', 'règle propre à un fournisseur ou à un montant', 'appeler l’IA'],
  services: ['business-operations/consolidation/commercial-adjustments-repair#diagnoseDocumentAdjustments',
    'business-operations/consolidation/commercial-adjustments-repair#repairDocumentAdjustments', 'business-operations/consolidation/consolidator#reconsolidateOperations'],
  chain: ['T1', 'T3', 'PERSISTENCE'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'BUSINESS_OPERATION_CHANGED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque analyse ou modification de document',
  criticality: 'HIGH',
  tests: ['L109D-U-ADJ', 'L109D-U-LINES', 'L109D-U-T3', 'L109D-U-GATE', 'L109D-E2E-01', 'L109D-E2E-05'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `${CANDIDATS('AND c.file_id > $2')} ORDER BY 1 LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    if (e.type === 'BUSINESS_OPERATION_CHANGED') {
      return idsOf(await rows(ctx.sql, `${CANDIDATS(`AND c.file_id IN (SELECT s.source_entity_key::int FROM business_operation_sources s
        WHERE s.account_id = $1 AND s.operation_id = $2 AND s.source_kind = 'DOCUMENT' AND s.source_entity_key ~ '^[0-9]{1,9}$')`)} ORDER BY 1`, [accountId, e.entityId]));
    }
    return idsOf(await rows(ctx.sql, `${CANDIDATS('AND c.file_id = $2')}`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { diagnoseDocumentAdjustments } = await import('@/services/business-operations/consolidation/commercial-adjustments-repair');
    for (const id of ids) {
      const d = await diagnoseDocumentAdjustments(ctx.sql, accountId, id, ctx.today);
      if (d.gone) { out.set(id, { verdict: 'GONE' }); continue; }
      const detail = {
        codes: d.codes, gaps: d.gaps.slice(0, 20), adjustmentOnlySources: d.adjustmentOnlySources.slice(0, 20),
        operations: d.operationIds, userDecisionOperations: d.userDecisionOperationIds,
      };
      if (d.operationIds.length) {
        out.set(id, {
          verdict: 'REPAIRABLE', faultyLink: 'T3',
          anomaly: d.gaps.some((g) => g.gap === 'FALSE_CREDIT') ? 'FALSE_CREDIT_COMPONENT' : d.adjustmentOnlySources.length ? 'ADJUSTMENT_ONLY_SOURCE' : 'PURCHASE_COMPONENTS_MISMATCH',
          expected: 'remise intégrée au net de l’achat ; un coût net par achat', observed: { gaps: d.gaps.length, adjustmentOnlySources: d.adjustmentOnlySources.length },
          detail, inputHash: hashOf({ id, g: d.gaps.map((g) => [g.componentId, g.kind, g.amountMinor]), s: d.adjustmentOnlySources.map((s) => s.sourceId) }),
        });
        continue;
      }
      if (d.gaps.length || d.adjustmentOnlySources.length) {
        // Écart sur une Opération soutenue par une décision de l'utilisateur : jamais modifiée, constat seulement.
        out.set(id, { verdict: 'FINDING', anomaly: 'USER_DECISION_PRESERVED', faultyLink: 'T3', detail, inputHash: hashOf({ id, g: d.gaps.map((g) => g.componentId) }) });
        continue;
      }
      out.set(id, { verdict: 'CONSISTENT', detail });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { diagnoseDocumentAdjustments, repairDocumentAdjustments } = await import('@/services/business-operations/consolidation/commercial-adjustments-repair');
    for (const { id } of items) {
      // Diagnostic relu au moment de réparer (jamais sur un état périmé).
      const d = await diagnoseDocumentAdjustments(ctx.sql, accountId, id, ctx.today);
      const r = await repairDocumentAdjustments(accountId, d, { today: ctx.today, correlationId: ctx.correlationId });
      out.set(id, {
        called: true, service: 'reconsolidateOperations', aiCalls: 0, reevaluation: 'TECHNICAL_REBUILD',
        result: { before: { gaps: d.gaps.map((g) => ({ id: g.componentId, kind: g.kind, amountMinor: g.amountMinor, gap: g.gap })), adjustmentOnlySources: d.adjustmentOnlySources.map((s) => s.sourceId) }, after: r },
        rollbackRef: r.reconsolidated.length ? `business_operation_history:operations:${r.reconsolidated.join(',')}` : null,
      });
    }
    return out;
  },
};
