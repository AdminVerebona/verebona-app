/**
 * COH-SUPPLIER-COORDINATES — coordonnées des fournisseurs reflétant les
 * sources documentaires ACTIVES (lot 111X, ticket « Fournisseurs —
 * coordonnées documentaires »). Ajouté EN FIN de registre, après
 * COH-CIL-DOCUMENT-PROJECTION (111U).
 *
 * Moteur existant (campagne exhaustive quotidienne des comptes éligibles +
 * contrôles ciblés à l'analyse, au dépôt, à la modification / suppression
 * d'un document et à la modification d'une fiche) — aucun système parallèle.
 * Réparation = seconde chance T3 (`recoverSupplierCoordinates`) : lecture de
 * la connaissance persistée, décision déterministe par champ, découpage IA
 * seulement si nécessaire et contrat porté, écriture par
 * `consolidateCoordinates`, historique par champ.
 *
 * Constats sur chaque fiche ACTIVE ayant au moins un document actif lié :
 *   REPAIRABLE  SUPPLIER_COORDINATE_MISSING — un champ vide a une valeur
 *               établie par une preuve fiable active (ou une valeur différente
 *               n'a pas encore sa revue de conflit) ;
 *   REPAIRABLE  SUPPLIER_COORDINATES_UNRECORDED — contexte jamais décidé :
 *               les abstentions (aucune preuve, preuve incertaine ou
 *               contradictoire, effacement de l'utilisateur) sont à persister ;
 *   FINDING     SUPPLIER_COORDINATES_CONTRACT_PENDING — une unité de
 *               l'émetteur doit être découpée et le prompt T3 actif ne porte
 *               pas `t3-knowledge-query-v3` (Supervision immédiate) ;
 *   AMBIGUOUS   SUPPLIER_COORDINATE_CONFLICT — revue de conflit de valeur
 *               ouverte : la décision de l'utilisateur est attendue.
 * Une fiche dont le contexte est déjà décidé est CONSISTENT : aucune nouvelle
 * lecture IA sans changement de contexte (empreinte des preuves).
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';
import { SUPPLIER_COORDINATES_CHECK_ID } from '@/services/ai/reconciliation/missing-properties/contract';

const VIVANTS = `s.account_id = $1 AND s.status = 'active'
  AND EXISTS (SELECT 1 FROM document_suppliers ds JOIN asset_files f ON f.id = ds.document_id AND f.account_id = s.account_id
               WHERE ds.supplier_id = s.id AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL)`;

export const supplierCoordinatesCheck: CoherenceCheck = {
  id: SUPPLIER_COORDINATES_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'Fournisseurs : coordonnées des documents actifs reprises sur la fiche, ou abstention / conflit tracés',
  domain: 'fournisseurs',
  level: 'N3',
  objectType: 'supplier',
  scope: 'fiches fournisseurs ACTIVES du compte liées à au moins un document actif',
  sources: ['suppliers', 'document_suppliers', 'asset_files', 'document_extractions', 'document_facts', 'document_unresolved_facts',
    'document_source_units', 'supplier_contact_observations', 'supplier_review_items', 'property_recovery_runs', 'property_recovery_decisions'],
  applicability: 'compte éligible ; fiche active ; document actif (non supprimé, non regroupé) lié par document_suppliers',
  invariant: 'toute coordonnée fiable (téléphone, e-mail, adresse, TVA, site, IBAN) lue dans un document actif du fournisseur alimente le champ vide correspondant, ou porte une abstention / un conflit de valeur explicite et persisté ; jamais l’adresse du destinataire, jamais un IBAN ou un site inventé',
  anomalies: ['SUPPLIER_COORDINATE_MISSING', 'SUPPLIER_COORDINATES_UNRECORDED', 'SUPPLIER_COORDINATES_CONTRACT_PENDING', 'SUPPLIER_COORDINATE_CONFLICT'],
  autoRepairWhen: 'valeur établie par une preuve active certaine pour un champ vide non effacé par l’utilisateur ; conflit de valeur sans revue ; contexte non décidé',
  forbiddenRepairs: ['remplacer une valeur renseignée', 'réintroduire un champ effacé par l’utilisateur', 'écrire depuis un document supprimé, regroupé ou délié',
    'écrire l’adresse du destinataire', 'inventer un IBAN ou un site', 'fusionner ou créer un fournisseur', 'relancer T1, l’OCR ou lire le fichier',
    'appeler une IA sans changement de contexte'],
  services: ['ai/reconciliation/missing-properties/supplier-service#recoverSupplierCoordinates', 'suppliers/supplier-service#consolidateCoordinates'],
  chain: ['T1', 'T3', 'PERSISTENCE'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'DOCUMENT_UPLOADED', 'DOCUMENT_DELETED', 'SUPPLIER_CHANGED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque analyse, modification de document ou de fiche',
  criticality: 'MEDIUM',
  immediateSupervision: ['SUPPLIER_COORDINATES_CONTRACT_PENDING'],
  // Découpage d'une unité à plusieurs champs : seule décision sémantique possible (T3 KNOWLEDGE_QUERY, contrat porté).
  semanticReevaluation: ['T3'],
  tests: ['L111X-U-READ', 'L111X-U-DECIDE', 'L111X-U-COVERAGE', 'L111X-E2E-AC01', 'L111X-E2E-AC10'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `SELECT s.id FROM suppliers s WHERE ${VIVANTS} AND s.id > $2 ORDER BY s.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    if (e.type === 'SUPPLIER_CHANGED') {
      return idsOf(await rows(ctx.sql, `SELECT s.id FROM suppliers s WHERE ${VIVANTS} AND s.id = $2`, [accountId, e.entityId]));
    }
    // Document : ses fournisseurs liés (un document supprimé garde son lien : la fiche est réexaminée sans lui).
    return idsOf(await rows(ctx.sql, `
      SELECT DISTINCT s.id FROM suppliers s JOIN document_suppliers ds ON ds.supplier_id = s.id
       WHERE s.account_id = $1 AND s.status = 'active' AND ds.document_id = $2`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { supplierCoordinatesState, supplierRecoveryReady } = await import('@/services/ai/reconciliation/missing-properties/supplier-service');
    const pret = await supplierRecoveryReady();
    for (const id of ids) {
      if (!pret) { out.set(id, { verdict: 'FINDING', anomaly: 'SUPPLIER_COORDINATES_UNRECORDED', faultyLink: 'PERSISTENCE', detail: { reason: 'SCHEMA_NOT_READY' } }); continue; }
      const st = await supplierCoordinatesState(accountId, id);
      if (!st || st.knowledge.documents.length === 0) { out.set(id, { verdict: st ? 'CONSISTENT' : 'GONE' }); continue; }
      const aFaire = st.plan.filter((x) => x.action !== 'ABSTAIN');
      const detail = {
        documents: st.knowledge.documents.map((d) => d.fileId),
        plan: st.plan.map((x) => ({ field: x.field, action: x.action, cause: x.cause, status: x.finding.status })),
        needsSplit: st.needsSplit, contextFp: st.contextFp,
      };
      const inputHash = hashOf({ id, fp: st.contextFp });
      if (!st.recorded && aFaire.length > 0) {
        out.set(id, { verdict: 'REPAIRABLE', anomaly: 'SUPPLIER_COORDINATE_MISSING', faultyLink: 'T3', expected: { filled: aFaire.map((x) => x.field) }, observed: detail, inputHash });
        continue;
      }
      if (!st.recorded) {
        out.set(id, { verdict: 'REPAIRABLE', anomaly: 'SUPPLIER_COORDINATES_UNRECORDED', faultyLink: 'T3', observed: detail, inputHash });
        continue;
      }
      if (st.needsSplit.length && !st.contract.contractCarried) {
        out.set(id, { verdict: 'FINDING', anomaly: 'SUPPLIER_COORDINATES_CONTRACT_PENDING', faultyLink: 'T3', observed: detail, inputHash });
        continue;
      }
      if (st.openConflicts > 0) {
        out.set(id, { verdict: 'AMBIGUOUS', anomaly: 'SUPPLIER_COORDINATE_CONFLICT', faultyLink: 'T3', observed: { ...detail, openConflicts: st.openConflicts }, inputHash });
        continue;
      }
      out.set(id, { verdict: 'CONSISTENT' });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { recoverSupplierCoordinates } = await import('@/services/ai/reconciliation/missing-properties/supplier-service');
    for (const id of intArray(items.map((i) => i.id))) {
      const r = await recoverSupplierCoordinates({ accountId, supplierId: id, trigger: ctx.trigger ?? 'COHERENCE', campaignId: ctx.campaignId ?? null, runRef: ctx.correlationId });
      out.set(id, {
        called: true, service: 'recoverSupplierCoordinates',
        result: { status: r.status, written: r.written, conflicts: r.conflicts, abstentions: r.abstentions, contractPending: r.contractPending },
        aiCalls: r.aiCalls,
        rollbackRef: `property_recovery_decisions:SUPPLIER=${id};suppliers.field_provenance`,
        reevaluation: 'SEMANTIC_REEVALUATION_T3',
      });
    }
    return out;
  },
};
