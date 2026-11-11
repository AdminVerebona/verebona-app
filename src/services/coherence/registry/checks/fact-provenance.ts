/**
 * COH-DOC-FACT-PROVENANCE — provenance des faits T1 vers les unités sources
 * et preuves par champ orphelines (lot 113AK, carte Trello #736 « T1 / Preuves
 * — Réparer les liens vers unités sources et assainir les preuves
 * orphelines »). Ajouté EN FIN de registre, après COH-OPS-PERIOD-RESOLUTION
 * (113AA). Complète COH-DOC-EXTRACT-CHAIN (omissions de l'extraction) sur le
 * maillon PERSISTANCE de la chaîne `document → extraction → unité source →
 * fait → field_evidence → propriété`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * OBJET : un document du compte qui porte des faits ACTIFS avec provenance
 * (ou déjà qualifiés) ou qui est la source de preuves ACTIVES — y compris un
 * document purgé que des preuves citent encore.
 *
 * INVARIANT : chaque référence d'un fait actif désigne une unité du MÊME
 * document (compte + document + identifiant ; une cellule vaut par sa ligne) ;
 * une preuve ACTIVE désigne un bien du compte, non supprimé, et un document du
 * compte, non supprimé, encore rattaché à ce bien. Moteur de qualification :
 * `source-units/provenance-integrity.ts` (pur), corrections et journal :
 * `source-units/provenance-repair.ts` — les MÊMES que le rattrapage BO.
 *
 * Distingue (détail de la preuve) : références historiques légitimes (faits
 * supersédés, biens archivés / vendus / transmis — jamais des anomalies), vrais
 * liens cassés (unité absente du document, éventuellement présente AILLEURS :
 * jamais une correspondance), contradictions, version remplacée, document
 * d'un autre compte, couche A pas encore reconstruite.
 *
 * RÉPARATION (déterministe, sans IA, sans relecture du fichier) :
 *   · FACT_PROVENANCE_BROKEN → provenance rétablie depuis l'extrait / la
 *     cellule / l'observation conservés du fait dans les unités du même
 *     document, sinon références invalides retirées et fait qualifié
 *     « provenance non reconstituable » (valeur conservée) ;
 *   · EVIDENCE_ORPHANED → preuve retirée de l'usage actif (WITHDRAWN) quand son
 *     bien ou son document est supprimé, purgé, transféré ou fusionné ; ligne
 *     conservée, qualification au journal.
 * Constats (jamais réécrits d'office) : contradiction, version remplacée,
 * document d'un autre compte, preuve d'un document qui n'est plus rattaché au
 * bien (rattrapage BO, après simulation), provenance non reconstituable
 * (écart subsistant, avec son motif).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

const CHECK_ID = 'COH-DOC-FACT-PROVENANCE';
const DETAIL_MAX = 20;

/** Inspection d'un document à partir de son état qualifié (pure, exportée pour les tests). */
export function inspectionOfProvenance(st: import('@/services/ai/source-analysis/source-units/provenance-repair').FileProvenanceState,
  unambiguous: ReadonlySet<string>): Inspection {
  const factsCasses = st.facts.filter((f) => f.state === 'BROKEN' && f.refs.some((r) => r.status === 'UNIT_MISSING'));
  const contradictions = st.facts.filter((f) => f.state === 'BROKEN' && !f.refs.some((r) => r.status === 'UNIT_MISSING'));
  const parEtat = (e: string) => st.facts.filter((f) => f.state === e);
  const preuves = st.evidence.filter((e) => e.withdraw);
  const auto = preuves.filter((e) => unambiguous.has(e.status));
  const deliees = preuves.filter((e) => !unambiguous.has(e.status));
  const ligne = (f: (typeof st.facts)[number]) => ({
    factId: f.factId, state: f.state, cause: f.cause,
    units: f.refs.filter((r) => r.status !== 'VALID' && r.status !== 'VALID_CELL').map((r) => ({ unit: r.ref, status: r.status, elsewhere: r.elsewhere })).slice(0, 5),
    relinked: f.relinked,
  });
  const detail = {
    accountId: st.accountId, fileId: st.fileId,
    document: { exists: st.doc.exists, deleted: st.doc.deleted, accountId: st.doc.accountId, extractionId: st.doc.currentExtractionId, layer: st.doc.hasCoverage },
    facts: {
      examined: st.facts.length, valid: parEtat('VALID').length, broken: factsCasses.length,
      relinkable: factsCasses.filter((f) => (f.relinked?.length ?? 0) > 0).length, contradictions: contradictions.length,
      supersededVersion: parEtat('SUPERSEDED_VERSION').length, sourceUnlinked: parEtat('SOURCE_UNLINKED').length,
      layerPending: parEtat('LAYER_PENDING').length, notReconstructible: parEtat('NOT_RECONSTRUCTIBLE').length, outOfScope: parEtat('OUT_OF_SCOPE').length,
      crossDocumentIds: st.facts.filter((f) => f.refs.some((r) => r.status === 'UNIT_MISSING' && r.elsewhere)).length,
    },
    evidence: {
      examined: st.evidence.length, valid: st.evidence.filter((e) => e.status === 'VALID').length,
      historicalArchived: st.evidence.filter((e) => e.status === 'HISTORICAL_ARCHIVED').length,
      orphaned: preuves.length,
      byStatus: Object.fromEntries([...new Set(preuves.map((e) => e.status))].map((s) => [s, preuves.filter((e) => e.status === s).length])),
    },
    brokenFacts: [...factsCasses, ...contradictions, ...parEtat('SUPERSEDED_VERSION'), ...parEtat('SOURCE_UNLINKED'), ...parEtat('NOT_RECONSTRUCTIBLE')]
      .slice(0, DETAIL_MAX).map(ligne),
    orphanEvidence: preuves.slice(0, DETAIL_MAX).map((e) => ({ evidenceId: e.evidenceId, assetId: e.assetId, fieldKey: e.fieldKey, status: e.status })),
  };
  const empreinte = hashOf({
    f: st.fileId,
    faits: st.facts.filter((f) => f.state !== 'VALID').map((f) => [f.factId, f.state, f.refs.map((r) => `${r.ref}:${r.status}`)]),
    preuves: preuves.map((e) => [e.evidenceId, e.status]),
  });
  const base = { faultyLink: 'PERSISTENCE' as const, detail, inputHash: empreinte };
  if (factsCasses.length) {
    return { ...base, verdict: 'REPAIRABLE', anomaly: 'FACT_PROVENANCE_BROKEN',
      expected: 'chaque référence d’un fait actif désigne une unité du même document', observed: detail.brokenFacts };
  }
  if (auto.length) {
    return { ...base, verdict: 'REPAIRABLE', anomaly: 'EVIDENCE_ORPHANED',
      expected: 'preuve active vers un bien et un document présents du compte', observed: detail.orphanEvidence };
  }
  const constat = (anomaly: string, observed: unknown): Inspection => ({ ...base, verdict: 'FINDING', anomaly, expected: 'provenance vérifiable', observed });
  if (deliees.length) return constat('EVIDENCE_SOURCE_UNLINKED', detail.orphanEvidence);
  if (contradictions.length) return constat('FACT_PROVENANCE_CONTRADICTION', contradictions.slice(0, DETAIL_MAX).map(ligne));
  if (parEtat('SUPERSEDED_VERSION').length) return constat('FACT_SUPERSEDED_VERSION_ACTIVE', parEtat('SUPERSEDED_VERSION').slice(0, DETAIL_MAX).map(ligne));
  if (parEtat('SOURCE_UNLINKED').length) return constat('FACT_SOURCE_UNLINKED', parEtat('SOURCE_UNLINKED').slice(0, DETAIL_MAX).map(ligne));
  if (parEtat('LAYER_PENDING').length) {
    return { ...constat('FACT_PROVENANCE_LAYER_PENDING', parEtat('LAYER_PENDING').slice(0, DETAIL_MAX).map(ligne)), detail: { ...detail, handledBy: 't1-source-units-backfill' } };
  }
  if (parEtat('NOT_RECONSTRUCTIBLE').length) return constat('FACT_PROVENANCE_NOT_RECONSTRUCTIBLE', parEtat('NOT_RECONSTRUCTIBLE').slice(0, DETAIL_MAX).map(ligne));
  if (!st.doc.exists && st.facts.length === 0 && st.evidence.length === 0) return { verdict: 'GONE' };
  return { verdict: 'CONSISTENT', detail };
}

export const factProvenanceCheck: CoherenceCheck = {
  id: CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'Provenance des faits T1 (unités sources du même document) et preuves par champ orphelines',
  domain: 'documents-t1',
  level: 'N1',
  objectType: 'document',
  scope: 'documents du compte portant des faits actifs avec provenance (ou qualifiés) ou cités par des preuves actives — document purgé compris',
  sources: ['document_facts', 'document_source_units', 'document_extractions', 'document_extraction_coverage', 'field_evidence', 'assets', 'asset_files', 'document_asset_links', 'document_fact_provenance_events'],
  applicability: 'compte éligible ; journal 1640 présent (sinon : lecture seule, aucune réparation)',
  invariant: 'référence d’un fait actif = unité du MÊME document (compte + document + identifiant, cellule par sa ligne) ; preuve active = bien et document présents du compte, document encore rattaché',
  anomalies: [
    'FACT_PROVENANCE_BROKEN', 'EVIDENCE_ORPHANED', 'EVIDENCE_SOURCE_UNLINKED', 'FACT_PROVENANCE_CONTRADICTION',
    'FACT_SUPERSEDED_VERSION_ACTIVE', 'FACT_SOURCE_UNLINKED', 'FACT_PROVENANCE_LAYER_PENDING', 'FACT_PROVENANCE_NOT_RECONSTRUCTIBLE',
  ],
  autoRepairWhen: 'référence d’unité absente du document (provenance rétablie depuis la preuve conservée, sinon « non reconstituable ») ; preuve active d’un bien / document supprimé, purgé, transféré ou fusionné',
  forbiddenRepairs: [
    'chercher l’unité dans un autre document', 'fabriquer une citation ou une provenance', 'supprimer la valeur d’un fait',
    'supprimer une preuve (la ligne reste, WITHDRAWN)', 'réécrire une référence résolue (contradiction : constat)', 'appeler l’IA ou relire le fichier',
    'retirer d’office la preuve d’un document seulement détaché (rattrapage BO après simulation)',
  ],
  services: [
    'ai/source-analysis/source-units/provenance-repair#inspectFileProvenance', 'ai/source-analysis/source-units/provenance-repair#applyFileCorrections',
  ],
  chain: ['PERSISTENCE', 'T3'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'DOCUMENT_DELETED', 'DOCUMENT_UPLOADED'],
  frequency: 'campagne exhaustive quotidienne (lecture seule, sans IA) + contrôle ciblé après chaque analyse ou modification du document',
  criticality: 'MEDIUM',
  tests: ['L113AK-U', 'L113AK-E2E'],

  async listObjects(ctx, accountId, afterId, limit) {
    const { listProvenanceObjects } = await import('@/services/ai/source-analysis/source-units/provenance-repair');
    return listProvenanceObjects(ctx.sql, accountId, afterId, limit);
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    return idsOf(await rows(ctx.sql, `
      SELECT $2::int AS id WHERE EXISTS (SELECT 1 FROM document_facts f WHERE f.account_id = $1 AND f.file_id = $2 AND f.status = 'active' AND cardinality(f.source_unit_ids) > 0)
         OR EXISTS (SELECT 1 FROM field_evidence fe WHERE fe.account_id = $1 AND fe.source_id = $2 AND fe.source_type IN ('document', 'web_link', 'asset_file', 'file')
                     AND (fe.lifecycle_status IS NULL OR fe.lifecycle_status = 'ACTIVE'))`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const { inspectFileProvenance, UNAMBIGUOUS_EVIDENCE_WITHDRAWALS } = await import('@/services/ai/source-analysis/source-units/provenance-repair');
    const etats = await inspectFileProvenance(ctx.sql, accountId, intArray(ids));
    const out = new Map<number, Inspection>();
    for (const id of ids) {
      const st = etats.get(id);
      out.set(id, st ? inspectionOfProvenance(st, UNAMBIGUOUS_EVIDENCE_WITHDRAWALS) : { verdict: 'GONE' });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const { inspectFileProvenance, applyFileCorrections, UNAMBIGUOUS_EVIDENCE_WITHDRAWALS, provenanceJournalReady } = await import('@/services/ai/source-analysis/source-units/provenance-repair');
    const out = new Map<number, RepairResult>();
    if (!(await provenanceJournalReady(ctx.sql))) {
      for (const { id } of items) out.set(id, { called: false, service: 'none', result: { skipped: 'JOURNAL_1640_ABSENT' } });
      return out;
    }
    // État RELU (jamais celui de l'inspection) : la garde optimiste des corrections fait le reste.
    const etats = await inspectFileProvenance(ctx.sql, accountId, items.map((i) => i.id));
    for (const { id } of items) {
      const st = etats.get(id);
      if (!st) { out.set(id, { called: false, service: 'none', result: { skipped: 'DOCUMENT_GONE' } }); continue; }
      const r = await applyFileCorrections(ctx.sql, st, { phase: 'CHECK', evidenceStatuses: UNAMBIGUOUS_EVIDENCE_WITHDRAWALS });
      out.set(id, {
        called: true, service: 'applyFileCorrections', aiCalls: 0, reevaluation: 'TECHNICAL_REBUILD',
        result: { relinked: r.relinked, notReconstructible: r.notReconstructible, evidenceWithdrawn: r.evidenceWithdrawn, events: r.events, assetsToReconcile: r.assetsToReconcile },
        rollbackRef: `document_fact_provenance_events:account=${accountId}:file=${id}:phase=CHECK`,
      });
    }
    return out;
  },
};
