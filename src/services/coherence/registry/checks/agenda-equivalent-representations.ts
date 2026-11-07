/**
 * COH-AGENDA-EQUIVALENT-REPRESENTATIONS — représentations ÉQUIVALENTES d'un
 * même fait réalisé dans l'Agenda d'un bien, TOUTES ORIGINES (lot 106A,
 * ticket P1 « Agenda — doublons DPE non autoréparés », cas Maison 22/12/2020).
 *
 * POURQUOI CE CONTRÔLE (cause DÉMONTRÉE du non-rattrapage, par le code) :
 *   · COH-AGENDA-OCCURRENCES n'examine que des OPÉRATIONS (intervention,
 *     sinistre, achat, cession) et leurs éléments : un DPE issu d'un dossier
 *     de diagnostic et d'un compromis n'a AUCUNE Opération — ses trois lignes
 *     n'étaient jamais énumérées ;
 *   · COH-AGENDA-ORPHANS ne retire que des éléments sans rattachement ;
 *     COH-AGENDA-HISTORICAL-STATUS ne qualifie que le STATUT d'un élément
 *     (il a rendu « Réalisé » l'une des représentations, laissant l'autre
 *     « à confirmer ») ; COH-DOC-AGENDA-LINKS ne juge que les liens ;
 *   · le dédoublonnage §14.6 (manuel) et la clé fonctionnelle T4-08 sont PAR
 *     DOCUMENT : deux documents ne se rapprochent jamais ; le rapprochement
 *     T4 (`findDuplicate`) était contourné pour un fait de plus de cinq ans ;
 *   · le point d'extension COH-AGENDA-T4-DOCUMENT-DEADLINES (groupes sans
 *     Opération) était seulement DÉCLARÉ (lacune de couverture).
 *
 * Objet : le BIEN (détection transversale par bien). Inspection en lecture
 * seule (modèle pur `agenda/equivalence/model.ts`) ; réparation :
 *   · identité CERTAINE → `applyAssetEquivalence` : absorption par le
 *     mécanisme existant (journal 0591, retrait tracé 0223, mémoire
 *     anti-recréation T4), canonique selon une règle stable, protections de
 *     l'utilisateur, preuves et liens réunis, intitulé non informatif
 *     remplacé, décision avant / après (`agenda_equivalence_decisions`) ;
 *   · INCERTAINE avec une Opération active → réévaluation T4 ciblée par
 *     l'orchestration existante (`reevaluateRepresentation`, éléments du
 *     groupe en candidats) ;
 *   · INCERTAINE sans Opération → constat qualifié (file durable
 *     `agenda_equivalence_decisions` T4_UNAVAILABLE), AUCUNE fusion — le
 *     contrat T4 « représentation sans Opération » est demandé au PO.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

export const EQUIVALENT_REPRESENTATIONS_CHECK_ID = 'COH-AGENDA-EQUIVALENT-REPRESENTATIONS';
/** Contrat IA demandé au PO pour décider un groupe incertain sans Opération. */
export const EQUIVALENCE_T4_CONTRACT = '106A-t4-representation-sans-operation';

interface Plan {
  consolidate: Array<{ groupKey: string; canonicalId: number | null; absorbIds: number[]; retitle: unknown; reason: string }>;
  t4Operations: Array<{ groupKey: string; operationId: number; itemIds: number[] }>;
  unavailable: Array<{ groupKey: string; itemIds: number[]; reason: string }>;
  distinct: Array<{ groupKey: string; reason: string }>;
  protected: Array<{ groupKey: string; canonicalId: number | null; kept: unknown }>;
  /** Documents décrivant la même occurrence (même référence stable, même date) non rattachés à sa représentation. */
  corroborations: Array<{ itemId: number; fileId: number }>;
}

export const agendaEquivalentRepresentationsCheck: CoherenceCheck = {
  id: EQUIVALENT_REPRESENTATIONS_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'Agenda : un même fait réalisé n’a qu’une représentation, quelle que soit son origine (fiche, document, T4, projection)',
  domain: 'agenda',
  level: 'N2',
  objectType: 'asset',
  scope: 'biens du compte portant au moins deux faits réalisés datés du même jour (toutes origines, historiques compris)',
  sources: ['agenda_items', 'agenda_asset_links', 'agenda_file_links', 'agenda_item_sources', 'agenda_equipment_links', 'document_facts', 'asset_files',
    'assets.key_characteristics', 'agenda_occurrence_events', 'agenda_data_conflicts', 'agenda_intervention_consolidations', 'agenda_equivalence_decisions'],
  applicability: 'compte éligible ; journal 0591 (origine COHERENCE) et table 1000 présents, trace 0223 présente (sinon constat seulement)',
  invariant: 'une occurrence réalisée (même bien, même nature canonique, même date, même référence stable) est représentée par UN élément portant toutes ses preuves ; les faits distincts restent distincts ; une réalisation n’est jamais confondue avec une échéance ; un choix de l’utilisateur n’est jamais écrasé',
  anomalies: ['EQUIVALENT_REPRESENTATIONS_CERTAIN', 'EQUIVALENT_PROOF_NOT_ATTACHED', 'EQUIVALENCE_T4_REEVALUATION', 'EQUIVALENCE_T4_DECISION_UNAVAILABLE', 'EQUIVALENCE_JOURNAL_MISSING'],
  autoRepairWhen: 'identité CERTAINE : référence stable unique et concordante (n° ADEME), chaque représentation ancrée par ses preuves (fait daté dans sa source, champ de la fiche), générique prouvé par le même dossier ; éléments absorbés automatiques et intacts',
  forbiddenRepairs: ['fusionner sur le seul intitulé ou la seule date', 'fusionner deux références stables différentes (deux DPE)', 'fusionner une réalisation et une échéance',
    'fusionner deux diagnostics distincts d’un même dossier', 'absorber un élément saisi, modifié, confirmé, au statut posé, restauré ou en conflit',
    'déduire une réalisation du titre ou de la date', 'supprimer un document ou une preuve', 'retirer sans trace restaurable'],
  services: ['agenda/equivalence/store#applyAssetEquivalence', 'business-operations/agenda-projection/consolidation#absorbEquivalentItemsInTx',
    'business-operations/semantic/orchestrator#reevaluateRepresentation'],
  chain: ['T1', 'T3', 'T4', 'PERSISTENCE', 'PROJECTION'],
  triggers: ['AGENDA_ITEM_CREATED', 'AGENDA_ITEM_UPDATED', 'SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'DOCUMENT_UPLOADED', 'ASSET_UPDATED', 'BUSINESS_OPERATION_CHANGED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque changement (document, bien, élément, Opération)',
  criticality: 'HIGH',
  tests: ['L106A-U-EQUIVALENCE', 'L106A-E2E-01', 'L106A-E2E-02', 'L106A-E2E-03', 'L106A-E2E-04', 'L106A-E2E-05', 'L106A-E2E-06', 'L106A-E2E-07', 'L106A-E2E-08'],
  semanticReevaluation: ['T4'],
  immediateSupervision: ['EQUIVALENCE_JOURNAL_MISSING'],

  async listObjects(ctx, accountId, afterId, limit) {
    const { assetsWithCandidateGroups } = await import('@/services/agenda/equivalence/store');
    return assetsWithCandidateGroups(ctx.sql, accountId, 'AND a.id > $2', [afterId], limit);
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null && e.assetId == null) return [];
    const { assetsWithCandidateGroups } = await import('@/services/agenda/equivalence/store');
    if (e.type === 'ASSET_UPDATED') return assetsWithCandidateGroups(ctx.sql, accountId, 'AND a.id = $2', [e.entityId]);
    if (e.type === 'AGENDA_ITEM_CREATED' || e.type === 'AGENDA_ITEM_UPDATED') {
      return assetsWithCandidateGroups(ctx.sql, accountId, 'AND a.id IN (SELECT l.asset_id FROM agenda_asset_links l WHERE l.agenda_item_id = $2)', [e.entityId]);
    }
    if (e.type === 'BUSINESS_OPERATION_CHANGED') {
      return assetsWithCandidateGroups(ctx.sql, accountId,
        'AND a.id IN (SELECT l.asset_id FROM agenda_asset_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.business_operation_id = $2)', [e.entityId]);
    }
    // Document analysé / modifié / déposé : biens des éléments qui le citent, et bien de l'analyse.
    const parDoc = e.entityId == null ? [] : await assetsWithCandidateGroups(ctx.sql, accountId, `AND a.id IN (
        SELECT l.asset_id FROM agenda_asset_links l JOIN agenda_items i ON i.id = l.agenda_item_id
         WHERE (i.origin_ref_type = 'asset_file' AND i.origin_ref_id = $2)
            OR EXISTS (SELECT 1 FROM agenda_file_links fl WHERE fl.agenda_item_id = i.id AND fl.asset_file_id = $2)
            OR EXISTS (SELECT 1 FROM agenda_item_sources s WHERE s.agenda_item_id = i.id AND s.asset_file_id = $2))`, [e.entityId]);
    const parBien = e.assetId ? await assetsWithCandidateGroups(ctx.sql, accountId, 'AND a.id = $2', [e.assetId]) : [];
    return [...new Set([...parDoc, ...parBien])].sort((a, b) => a - b);
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { equivalenceJournalReady, diagnoseAssetEquivalence } = await import('@/services/agenda/equivalence/store');
    const pret = await equivalenceJournalReady(ctx.sql);
    const vivants = new Set(idsOf(await rows(ctx.sql, `SELECT id FROM assets WHERE account_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL`, [accountId, intArray(ids)])));
    for (const id of ids) {
      if (!vivants.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      const d = await diagnoseAssetEquivalence(ctx.sql, accountId, id);
      if (!d) { out.set(id, { verdict: 'GONE' }); continue; }
      const plan: Plan = { consolidate: [], t4Operations: [], unavailable: [], distinct: [], protected: [], corroborations: d.corroborations.map((c) => ({ itemId: c.itemId, fileId: c.fileId })) };
      for (const g of d.decisions) {
        if (g.verdict === 'CONSOLIDATE') {
          plan.consolidate.push({ groupKey: g.group.key, canonicalId: g.canonicalId, absorbIds: g.absorbIds, retitle: g.retitle, reason: g.reason });
        }
        if (g.uncertainIds.length) {
          if (g.operationIds.length) plan.t4Operations.push({ groupKey: g.group.key, operationId: g.operationIds[0], itemIds: [...new Set([...g.uncertainIds, ...(g.canonicalId ? [g.canonicalId] : [])])] });
          else plan.unavailable.push({ groupKey: g.group.key, itemIds: g.uncertainIds, reason: g.reason });
        }
        if (g.verdict === 'DISTINCT') plan.distinct.push({ groupKey: g.group.key, reason: g.reason });
        if (g.verdict === 'PROTECTED') plan.protected.push({ groupKey: g.group.key, canonicalId: g.canonicalId, kept: g.kept });
      }
      const detail = { ...plan, fingerprints: d.decisions.map((g) => g.fingerprint) };
      if ((plan.consolidate.length || plan.t4Operations.length || plan.corroborations.length) && !pret) {
        out.set(id, { verdict: 'FINDING', anomaly: 'EQUIVALENCE_JOURNAL_MISSING', faultyLink: 'PERSISTENCE', detail, inputHash: hashOf({ id, j: 'missing', f: detail.fingerprints }) });
        continue;
      }
      if (plan.consolidate.length || plan.corroborations.length) {
        out.set(id, {
          verdict: 'REPAIRABLE', anomaly: plan.consolidate.length ? 'EQUIVALENT_REPRESENTATIONS_CERTAIN' : 'EQUIVALENT_PROOF_NOT_ATTACHED', faultyLink: 'T4',
          expected: 'une seule représentation par occurrence réalisée (preuves et liens réunis)',
          observed: plan.consolidate.map((c) => ({ groupKey: c.groupKey, canonicalId: c.canonicalId, absorbIds: c.absorbIds })),
          detail: { ...detail, nature: 'TECHNICAL_REBUILD' }, inputHash: hashOf({ id, c: plan.consolidate, p: plan.corroborations, f: detail.fingerprints }),
        });
        continue;
      }
      if (plan.t4Operations.length) {
        // Diagnostic T4 SANS appel ni écriture (mode à blanc de l'orchestration existante, comme COH-AGENDA-OCCURRENCES).
        const { reevaluateRepresentation } = await import('@/services/business-operations/semantic/orchestrator');
        const aDemander: Plan['t4Operations'] = [];
        const etats: Array<Record<string, unknown>> = [];
        for (const o of plan.t4Operations) {
          const r = await reevaluateRepresentation({
            accountId, operationId: o.operationId, trigger: 'COHERENCE', triggerRef: ctx.correlationId, correlationId: ctx.correlationId,
            extraItemIds: o.itemIds, today: ctx.today, mode: 'DRY_RUN', deps: { sql: ctx.sql },
          });
          etats.push({ groupKey: o.groupKey, operationId: o.operationId, status: r.status, settled: r.settledBy?.status ?? null, reason: r.reason ?? null });
          if (r.status === 'UNAVAILABLE') plan.unavailable.push({ groupKey: o.groupKey, itemIds: o.itemIds, reason: `T4_${r.reason ?? 'UNAVAILABLE'}` });
          else if (r.status !== 'NOT_NEEDED' && r.status !== 'SETTLED' && r.status !== 'DEFERRED') aDemander.push(o);
        }
        if (aDemander.length) {
          out.set(id, {
            verdict: 'REPAIRABLE', anomaly: 'EQUIVALENCE_T4_REEVALUATION', faultyLink: 'T4',
            expected: 'représentation décidée par T4 (identité incertaine : aucune fusion par le code)', observed: aDemander,
            detail: { ...detail, t4Operations: aDemander, t4States: etats, nature: 'SEMANTIC_REEVALUATION_T4' }, inputHash: hashOf({ id, t4: aDemander, f: detail.fingerprints }),
          });
          continue;
        }
        if (!plan.unavailable.length) {
          const ambigu = etats.some((e) => e.status === 'DEFERRED' || e.settled === 'REJECTED' || e.settled === 'ABSTAINED' || e.settled === 'AI_FAILED' || e.settled === 'FAILED');
          out.set(id, ambigu
            ? { verdict: 'AMBIGUOUS', anomaly: 'EQUIVALENCE_T4_REEVALUATION', faultyLink: 'T4', detail: { ...detail, t4States: etats }, inputHash: hashOf({ id, etats, f: detail.fingerprints }) }
            : { verdict: 'CONSISTENT', detail: { ...detail, t4States: etats } });
          continue;
        }
      }
      if (plan.unavailable.length) {
        out.set(id, {
          verdict: 'FINDING', anomaly: 'EQUIVALENCE_T4_DECISION_UNAVAILABLE', faultyLink: 'T4',
          expected: 'décision T4 sur des représentations possiblement équivalentes sans événement de référence', observed: plan.unavailable,
          detail: { ...detail, aiContract: EQUIVALENCE_T4_CONTRACT, repairChain: 'aucune fusion tant que l’identité n’est pas certaine' },
          inputHash: hashOf({ id, u: plan.unavailable, f: detail.fingerprints }),
        });
        continue;
      }
      out.set(id, { verdict: 'CONSISTENT', detail });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { applyAssetEquivalence } = await import('@/services/agenda/equivalence/store');
    for (const { id, inspection } of items) {
      if (inspection.anomaly === 'EQUIVALENCE_T4_REEVALUATION') {
        const { reevaluateRepresentation } = await import('@/services/business-operations/semantic/orchestrator');
        const ops = ((inspection.detail as Plan | undefined)?.t4Operations ?? []);
        const resultats: Array<Record<string, unknown>> = [];
        let aiCalls = 0;
        let pending = false;
        const passCalls = { n: 0 };
        for (const o of ops) {
          const r = await reevaluateRepresentation({
            accountId, operationId: o.operationId, trigger: 'COHERENCE', triggerRef: `${EQUIVALENT_REPRESENTATIONS_CHECK_ID}:${o.groupKey}`, correlationId: ctx.correlationId,
            extraItemIds: o.itemIds, today: ctx.today, passCalls, deps: { sql: ctx.sql },
          });
          aiCalls += r.aiCalls;
          if (r.status === 'DEFERRED') pending = true;
          resultats.push({ groupKey: o.groupKey, operationId: o.operationId, status: r.status, journalId: r.journalId, applied: r.applied, refused: r.refused, reason: r.reason ?? null });
        }
        out.set(id, {
          called: true, service: 'reevaluateRepresentation', aiCalls, reevaluation: 'SEMANTIC_REEVALUATION_T4', ...(pending ? { pending: true } : {}),
          result: { groups: resultats }, rollbackRef: 'operation_semantic_reevaluations',
        });
        continue;
      }
      const r = await applyAssetEquivalence(ctx.sql, accountId, id, { correlationId: ctx.correlationId, campaignId: ctx.campaignId ?? null, trigger: ctx.trigger ?? null });
      // Groupes restés incertains : file durable (le recontrôle peut ne laisser qu'un constat, jamais silencieux).
      const { diagnoseAssetEquivalence, recordUncertainGroups } = await import('@/services/agenda/equivalence/store');
      const reste = await diagnoseAssetEquivalence(ctx.sql, accountId, id);
      if (reste) {
        await recordUncertainGroups(ctx.sql, accountId, id, reste.decisions, {
          correlationId: ctx.correlationId, campaignId: ctx.campaignId ?? null, trigger: ctx.trigger ?? null,
          unavailableGroupKeys: new Set(reste.decisions.filter((g) => !g.operationIds.length).map((g) => g.group.key)),
        });
      }
      out.set(id, {
        called: true, service: 'applyAssetEquivalence', aiCalls: 0, reevaluation: 'TECHNICAL_REBUILD',
        result: { skipped: r.skipped ?? null, groups: r.applied.map((g) => ({ ...g })), attached: r.attached ?? [] },
        rollbackRef: `agenda_intervention_consolidations:origin=COHERENCE;correlation=${ctx.correlationId}`,
      });
    }
    return out;
  },

  async recordOutcomes(ctx, accountId, items) {
    // File durable des groupes incertains (une ligne par empreinte) : visible au diagnostic global.
    const { diagnoseAssetEquivalence, recordUncertainGroups } = await import('@/services/agenda/equivalence/store');
    for (const it of items) {
      if (it.inspection?.anomaly !== 'EQUIVALENCE_T4_DECISION_UNAVAILABLE' && it.inspection?.anomaly !== 'EQUIVALENCE_T4_REEVALUATION') continue;
      const d = await diagnoseAssetEquivalence(ctx.sql, accountId, it.id);
      if (d) {
        await recordUncertainGroups(ctx.sql, accountId, it.id, d.decisions, {
          correlationId: ctx.correlationId, campaignId: ctx.campaignId ?? null, trigger: ctx.trigger ?? null,
          unavailableGroupKeys: new Set(((it.inspection?.detail as Plan | undefined)?.unavailable ?? []).map((u) => u.groupKey)),
        });
      }
    }
  },
};
