/**
 * COH-CIL-DOCUMENT-PROJECTION — faits documentaires → structures CIL →
 * Informations / préparation / PDF (lot 111U, ticket « CIL : chaîne DPE et
 * données structurées de bout en bout », annexe 3 §L et §M).
 *
 * Rattrapage du STOCK et contrôle permanent par le moteur existant (campagne
 * quotidienne + contrôles ciblés ; comptes éligibles seulement) — aucun
 * système parallèle, aucune réanalyse T1 globale : la réparation REJOUE la
 * projection déterministe sur les faits T1 déjà persistés.
 *
 * Constats sur chaque bien immobilier :
 *   REPAIRABLE  CIL_FACTS_NOT_PROJECTED — des faits acceptés d'un document
 *               énergétique rattaché (DPE, audit…) ne sont pas (ou plus) reflétés
 *               dans `energy_materials` / `equipment_cil_specs` / le journal
 *               (document antérieur au lot, source retirée, nouvelle version).
 *               Réparation : `projectCilDocumentsForAsset` (idempotente,
 *               protections USER / ADMIN, jamais de travaux réalisés).
 *   AMBIGUOUS   CIL_PROJECTION_TO_CONFIRM — sources contradictoires ou
 *               plusieurs équipements candidats : rien n'est écrit, l'onglet
 *               Informations affiche « À confirmer ».
 *   FINDING     CIL_CREATED_EQUIPMENT_SOURCE_REMOVED — équipement créé depuis
 *               un document dont la preuve a disparu : jamais supprimé
 *               automatiquement (constat BO) ;
 *   FINDING     CIL_STATE_DIVERGENCE — préparation (blocs) et état granulaire
 *               discordants (filet de sécurité : même projection par
 *               construction).
 * Jamais : écraser une saisie USER / ADMIN, créer un travail réalisé depuis une
 * recommandation, supprimer un équipement, relancer T1, appeler une IA.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

const ASSETS_SQL = `a.account_id = $1 AND a.deleted_at IS NULL AND a.category = 'IMMOBILIER'`;

export const cilDocumentProjectionCheck: CoherenceCheck = {
  id: 'COH-CIL-DOCUMENT-PROJECTION',
  // v2 (lot 111U, deuxième passe) : coefficient U, contexte B2 depuis un fait explicite, travaux B7 réalisés prouvés.
  version: 2,
  status: 'ACTIVE',
  title: 'CIL : faits documentaires reflétés dans les structures spécialisées, l’onglet Informations et l’export',
  domain: 'biens',
  level: 'N3',
  objectType: 'asset',
  scope: 'biens immobiliers non supprimés du compte',
  sources: ['asset_files', 'document_asset_links', 'document_facts', 'energy_materials', 'equipments', 'equipment_cil_specs', 'asset_cil_profiles',
    'business_operations', 'business_operation_sources', 'business_operation_documents', 'business_operation_equipment_links', 'cil_projection_journal', 'cil_block_resolutions'],
  applicability: 'compte éligible ; bien immobilier',
  invariant: 'les faits acceptés des documents énergétiques rattachés sont projetés (ou leur abstention tracée) dans energy_materials / equipments / equipment_cil_specs / asset_cil_profiles ; seules les interventions RÉALISÉES prouvées par facture ou attestation sont des travaux B7 ; une recommandation ou un devis n’est jamais un travail réalisé ; Informations, préparation et PDF lisent le même état',
  anomalies: ['CIL_FACTS_NOT_PROJECTED', 'CIL_PROJECTION_TO_CONFIRM', 'CIL_CREATED_EQUIPMENT_SOURCE_REMOVED', 'CIL_STATE_DIVERGENCE'],
  autoRepairWhen: 'projection déterministe différente de l’état en base (faits persistés non projetés, source retirée d’une ligne DOCUMENT)',
  forbiddenRepairs: ['modifier une valeur ou une ligne USER / ADMIN', 'créer un travail réalisé (energy_works) depuis une recommandation',
    'supprimer un équipement', 'relancer une analyse T1 ou appeler une IA', 'trancher une contradiction entre documents de même date',
    'modifier une Opération ou créer une ligne energy_works', 'modifier un profil CIL USER / ADMIN'],
  services: ['cil/projection/document-projection#projectCilDocumentsForAsset', 'cil/state#getCilState'],
  chain: ['T1', 'T3', 'PERSISTENCE', 'PROJECTION'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'DOCUMENT_UPLOADED', 'ASSET_UPDATED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque analyse ou modification de document',
  criticality: 'MEDIUM',
  tests: ['L111U-U-VOCAB', 'L111U-U-STATE', 'L111U-E2E-03', 'L111U-E2E-05', 'L111U-E2E-06'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `SELECT a.id FROM assets a WHERE ${ASSETS_SQL} AND a.id > $2 ORDER BY a.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.assetId) return idsOf(await rows(ctx.sql, `SELECT a.id FROM assets a WHERE ${ASSETS_SQL} AND a.id = $2`, [accountId, e.assetId]));
    if (e.entityId == null) return [];
    // Document : ses biens (colonnes et liens actifs).
    return idsOf(await rows(ctx.sql, `
      SELECT DISTINCT a.id FROM assets a
       WHERE ${ASSETS_SQL} AND a.id IN (
         SELECT f.asset_id FROM asset_files f WHERE f.id = $2 AND f.account_id = $1
         UNION SELECT f.linked_asset_id FROM asset_files f WHERE f.id = $2 AND f.account_id = $1
         UNION SELECT l.asset_id FROM document_asset_links l WHERE l.file_id = $2 AND l.status = 'ACTIVE')`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const vivants = new Set(idsOf(await rows(ctx.sql, `SELECT a.id FROM assets a WHERE ${ASSETS_SQL} AND a.id = ANY($2::int[])`, [accountId, intArray(ids)])));
    const { projectCilDocumentsForAsset } = await import('@/services/cil/projection/document-projection');
    const { loadCilStateInput } = await import('@/services/cil/state/load');
    const { readinessFromCilInput } = await import('@/services/exports/cil-preparation.service');
    for (const id of ids) {
      if (!vivants.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      const r = await projectCilDocumentsForAsset({ accountId, assetId: id, dryRun: true });
      if (r.skipped === 'SCHEMA_NOT_READY') { out.set(id, { verdict: 'FINDING', anomaly: 'CIL_FACTS_NOT_PROJECTED', faultyLink: 'PERSISTENCE', detail: { reason: 'SCHEMA_NOT_READY' } }); continue; }
      const detail = { sourceDocuments: r.sourceDocuments, recognized: r.recognized, outcomes: r.outcomes, abstentions: r.abstentions };
      if (r.changed || r.journalChanges > 0) {
        out.set(id, { verdict: 'REPAIRABLE', anomaly: 'CIL_FACTS_NOT_PROJECTED', faultyLink: 'T3', expected: { projected: true }, observed: detail, inputHash: hashOf({ id, detail }) });
        continue;
      }
      if (r.outcomes.SOURCE_REMOVED) {
        out.set(id, { verdict: 'FINDING', anomaly: 'CIL_CREATED_EQUIPMENT_SOURCE_REMOVED', faultyLink: 'PERSISTENCE', observed: detail, inputHash: hashOf({ id, detail }) });
        continue;
      }
      if (r.outcomes.AMBIGUOUS || r.outcomes.CONFLICT) {
        out.set(id, { verdict: 'AMBIGUOUS', anomaly: 'CIL_PROJECTION_TO_CONFIRM', faultyLink: 'T3', observed: detail, inputHash: hashOf({ id, detail }) });
        continue;
      }
      // Concordance préparation ↔ état granulaire (même entrée).
      const input = await loadCilStateInput({ id, accountId });
      if (input) {
        const rd = readinessFromCilInput(input);
        const item = (x: string) => rd.state!.blocks.flatMap((b) => b.items).find((i) => i.id === x)!;
        const b8 = rd.blocks.find((b) => b.id === 'B8')!;
        if ((b8.status === 'complete') !== (item('B8.dpeDocument').status === 'renseigne')
          || JSON.stringify([...(rd.energyEquipmentIds ?? [])].sort()) !== JSON.stringify([...rd.state!.energyEquipmentIds].sort())) {
          out.set(id, { verdict: 'FINDING', anomaly: 'CIL_STATE_DIVERGENCE', faultyLink: 'PROJECTION', inputHash: hashOf({ id, b8: b8.status }) });
          continue;
        }
      }
      out.set(id, { verdict: 'CONSISTENT' });
    }
    return out;
  },

  async repair(_ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { projectCilDocumentsForAsset } = await import('@/services/cil/projection/document-projection');
    for (const { id } of items) {
      const r = await projectCilDocumentsForAsset({ accountId, assetId: id });
      out.set(id, {
        called: true, service: 'projectCilDocumentsForAsset',
        result: { outcomes: r.outcomes, abstentions: r.abstentions, createdEquipments: r.createdEquipmentIds.length, changed: r.changed },
        aiCalls: 0,
        rollbackRef: `cil_projection_journal:asset_id=${id}`,
        reevaluation: 'TECHNICAL_REBUILD',
      });
    }
    return out;
  },
};
