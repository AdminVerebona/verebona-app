/**
 * Lot 40 (O2) — candidats Opération de T1 sur base réelle (CDC Opérations V1
 * C3, C3.2, C9, C9.1, T1-OP-009 ; F-001, F-004, F-063).
 *
 * Chaîne exercée : passerelle réelle (master du dépôt, contrat v4, rejeu) →
 * lecture tolérante → ancrage → barrière serveur → projection →
 * `persistDocumentKnowledge` (faits + candidats, MÊME transaction).
 * Aucune Opération n'est créée (T3 = lot suivant).
 */
import { it, expect } from 'vitest';
import { scenario } from '../scenario';
import { loadT1Fixture, type T1Fixture } from '@/services/ai/source-analysis/__fixtures__/t1/load';
import type { AnalysisContext, SourceInput } from '@/services/ai/source-analysis/types';

function recording(f: T1Fixture, ids: Record<number, number>, transform?: (o: Record<string, unknown>) => void) {
  let json = JSON.stringify(f.recording.output);
  for (const [fictif, reel] of Object.entries(ids)) {
    json = json.replace(new RegExp(`("entityId":)${fictif}\\b`, 'g'), `$1${reel}`);
  }
  const output = JSON.parse(json) as Record<string, unknown>;
  transform?.(output);
  return { operationCode: f.recording.operationCode, task: f.recording.task, output };
}

type Cand = {
  id: number; candidate_key: string; status: string; established: boolean; confidence: string; type_hint: string | null;
  status_hint: string | null; analysis_run_id: number | null; extraction_id: number; t3_pending: boolean; trigger_code: string;
  payload: { evidence: Array<{ factId: number | null; fingerprint: string }>; evidenceFactIds: number[]; financialHints: Array<{ role: string; amountMinor: number; currency: string; evidence: { factId: number | null } }>; sourceRoleHint: string | null; unresolvedEvidence: number };
};

scenario('L40-O2', 'Candidats Opération de T1 : persistance, ancrage, supersession', ({ sql, make, useRecordings: rejouer }) => {
  async function analyser(p: { compte: { id: number; ownerUserId: number }; bienId: number; nom: string; fichierId: number; f: T1Fixture; ids: Record<number, number>; runId?: number | null; transform?: (o: Record<string, unknown>) => void }) {
    await rejouer([recording(p.f, p.ids, p.transform)]);
    const { analyseGroupWithMaster } = await import('@/services/ai/source-analysis/master/analyse-group-master');
    const { buildKnowledgeFromSourceAnalysis } = await import('@/services/ai/knowledge/document-knowledge');
    const { persistDocumentKnowledge } = await import('@/services/ai/knowledge/document-knowledge.service');
    const { emptyTrace } = await import('@/services/ai/source-analysis/trace');
    const input: SourceInput = {
      sourceType: 'file', sourceIds: [p.fichierId], accountId: p.compte.id, userId: p.compte.ownerUserId,
      mimeTypes: ['application/pdf'], displayNames: ['document.pdf'], linkedAssetId: p.bienId,
    };
    const ctx: AnalysisContext = {
      accountId: p.compte.id, userId: p.compte.ownerUserId, linkedAssetId: p.bienId, existingTitles: [],
      assets: [{ id: p.bienId, name: p.nom, category: 'VEHICULE', subtype: null }], rooms: [], equipments: [],
    };
    const m = await analyseGroupWithMaster(input, [0], ctx, emptyTrace());
    await persistDocumentKnowledge(buildKnowledgeFromSourceAnalysis(m.result, {
      accountId: p.compte.id, fileId: p.fichierId, analysisRunId: p.runId ?? null, assetIdAtAnalysis: p.bienId,
      sourceType: 'asset_file', multiAsset: m.projection.multiAsset, promptVersion: m.promptVersion, sourceLayer: m.sourceLayer,
      operationCandidates: m.operationCandidates,
    }));
    return m;
  }
  const candidats = (fileId: number) => sql<Cand[]>`
    SELECT id::int AS id, candidate_key, status, established, confidence, type_hint, status_hint, analysis_run_id, extraction_id,
           t3_pending, trigger_code, payload
      FROM document_operation_candidates WHERE file_id = ${fileId} ORDER BY id`;
  const run = async (compteId: number, fileId: number) => (await sql<{ id: number }[]>`
    INSERT INTO document_analysis_runs (asset_file_id, account_id, state, input_file_hash)
    VALUES (${fileId}, ${compteId}, 'COMPLETED', md5(random()::text)) RETURNING id`)[0].id;

  it('C3-E2E-01 / F-001 — facture de réparation : un candidat INTERVENTION REALIZED actif, preuves ancrées sur les faits PERSISTÉS, marqué pour T3', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const fichier = await make.assetFile(compte, { assetId: clio.id });
    const runId = await run(compte.id, fichier.id).catch(() => null);
    await analyser({ compte, bienId: clio.id, nom: 'Clio', fichierId: fichier.id, f: loadT1Fixture('t1-40-01-facture-reparation.json'), ids: { 12: clio.id }, runId });

    const [c, ...autres] = await candidats(fichier.id);
    expect(autres).toEqual([]);
    expect(c).toMatchObject({
      candidate_key: 'op1', status: 'ACTIVE', established: true, confidence: 'certain', type_hint: 'INTERVENTION', status_hint: 'REALIZED',
      t3_pending: true, trigger_code: 'source_analyzed', analysis_run_id: runId,
    });
    expect(c.payload.sourceRoleHint).toBe('INVOICE');
    // Ancrage stable : chaque preuve désigne un fait ACTIF de CE fichier.
    expect(c.payload.unresolvedEvidence).toBe(0);
    const faits = await sql<{ id: number; status: string; file_id: number; value_text: string | null }[]>`
      SELECT id::int AS id, status, file_id, value_text FROM document_facts WHERE id = ANY(${c.payload.evidenceFactIds}::bigint[])`;
    expect(faits).toHaveLength(4);
    expect(faits.every((f) => f.status === 'active' && f.file_id === fichier.id)).toBe(true);
    // Montant en unités mineures + devise, prouvé par le fait du total.
    expect(c.payload.financialHints).toEqual([expect.objectContaining({ role: 'REALIZED_COST', amountMinor: 74900, currency: 'EUR' })]);
    const [total] = await sql<{ value_text: string }[]>`SELECT value_text FROM document_facts WHERE id = ${c.payload.financialHints[0].evidence.factId}`;
    expect(total.value_text).toBe('74900');
    // Aucune Opération créée par T1 (T1-OP-007).
    expect(await sql`SELECT id FROM business_operations WHERE account_id = ${compte.id}`).toHaveLength(0);
  });

  it('C3-E2E-02 / C9 — réanalyse : anciens candidats SUPERSEDED, nouveaux actifs (même clé), preuves sur les NOUVEAUX faits ; candidat jamais consolidé : rien à retirer pour T3', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const fichier = await make.assetFile(compte, { assetId: clio.id });
    const f = loadT1Fixture('t1-40-01-facture-reparation.json');
    await analyser({ compte, bienId: clio.id, nom: 'Clio', fichierId: fichier.id, f, ids: { 12: clio.id } });
    await analyser({ compte, bienId: clio.id, nom: 'Clio', fichierId: fichier.id, f, ids: { 12: clio.id } });

    const l = await candidats(fichier.id);
    expect(l.map((c) => [c.candidate_key, c.status, c.t3_pending, c.trigger_code])).toEqual([
      ['op1', 'SUPERSEDED', false, 'source_analyzed'],
      ['op1', 'ACTIVE', true, 'source_reanalyzed'],
    ]);
    expect(l[0].extraction_id).toBe(l[1].extraction_id); // UPSERT : extraction_id n'est pas une version
    const statuts = async (ids: number[]) => (await sql<{ status: string }[]>`SELECT status FROM document_facts WHERE id = ANY(${ids}::bigint[])`).map((r) => r.status);
    expect(new Set(await statuts(l[0].payload.evidenceFactIds))).toEqual(new Set(['superseded']));
    expect(new Set(await statuts(l[1].payload.evidenceFactIds))).toEqual(new Set(['active']));
  });

  it('C3-E2E-03 / F-063 — réanalyse sans candidat (sortie v3) : l’ancien candidat déjà consolidé par T3 est retiré et RÉVEILLE T3 ; aucun actif', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const fichier = await make.assetFile(compte, { assetId: clio.id });
    const f = loadT1Fixture('t1-40-01-facture-reparation.json');
    await analyser({ compte, bienId: clio.id, nom: 'Clio', fichierId: fichier.id, f, ids: { 12: clio.id } });
    // T3 (lot suivant) aura consolidé le candidat.
    await sql`UPDATE document_operation_candidates SET t3_pending = false, t3_processed_at = now() WHERE file_id = ${fichier.id}`;
    await analyser({ compte, bienId: clio.id, nom: 'Clio', fichierId: fichier.id, f, ids: { 12: clio.id }, transform: (o) => { delete o.businessOperationCandidates; } });

    const l = await candidats(fichier.id);
    expect(l.map((c) => [c.status, c.t3_pending])).toEqual([['SUPERSEDED', true]]);
    // Les faits, eux, sont bien écrits (une sortie v3 reste valide).
    expect((await sql`SELECT id FROM document_facts WHERE file_id = ${fichier.id} AND status = 'active'`).length).toBeGreaterThan(0);
  });

  it('C3-E2E-04 / F-004 — notice : aucun candidat établi (le candidat proposé à tort est conservé non établi, sans réveiller T3)', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison de Lyon' });
    const fichier = await make.assetFile(compte, { assetId: maison.id });
    await analyser({ compte, bienId: maison.id, nom: 'Maison de Lyon', fichierId: fichier.id, f: loadT1Fixture('t1-40-07-notice-sans-candidat.json'), ids: { 20: maison.id } });
    const l = await candidats(fichier.id);
    expect(l.map((c) => [c.established, c.t3_pending, (c.payload as unknown as { exclusionReason: string }).exclusionReason])).toEqual([[false, false, 'DOCUMENT_TYPE_NOT_BUSINESS']]);
  });

  it('C3-E2E-05 — reprise ciblée (insertFactRows seul) : faits ajoutés, candidats et ancres inchangés', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const fichier = await make.assetFile(compte, { assetId: clio.id });
    await analyser({ compte, bienId: clio.id, nom: 'Clio', fichierId: fichier.id, f: loadT1Fixture('t1-40-01-facture-reparation.json'), ids: { 12: clio.id } });
    const avant = await candidats(fichier.id);
    const { insertFactRows } = await import('@/services/ai/knowledge/document-knowledge.service');
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      const ids = await insertFactRows(tx as never, { accountId: compte.id, fileId: fichier.id, sourceType: 'asset_file', provider: null, model: null, promptVersion: null },
        avant[0].extraction_id, [{
          factKey: 'kilometrage', subject: null, attribute: null, label: 'Kilométrage', valueText: '78000', valueNumber: 78000, valueUnit: 'km',
          valueJson: 78000, normalizedValue: '78000', periodStart: null, periodEnd: null, confidence: 'certain', excerpt: '78 000 km', location: {},
          evidenceOrigin: 'TEXT_EXTRACTION', visualEvidence: null,
        }], { canonical: false, provenance: false });
      expect(ids).toHaveLength(1);
      expect(Number.isInteger(ids[0])).toBe(true);
    });
    const apres = await candidats(fichier.id);
    expect(apres).toEqual(avant);
    const actifs = await sql`SELECT id FROM document_facts WHERE id = ANY(${apres[0].payload.evidenceFactIds}::bigint[]) AND status = 'active'`;
    expect(actifs).toHaveLength(apres[0].payload.evidenceFactIds.length);
  });

  it('C3-E2E-06 — un candidat impossible à écrire n’emporte jamais les faits (point de sauvegarde) ; aucun candidat actif orphelin', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const fichier = await make.assetFile(compte, { assetId: clio.id });
    const f = loadT1Fixture('t1-40-01-facture-reparation.json');
    await analyser({ compte, bienId: clio.id, nom: 'Clio', fichierId: fichier.id, f, ids: { 12: clio.id } });
    const { buildKnowledgeFromSourceAnalysis } = await import('@/services/ai/knowledge/document-knowledge');
    const { persistDocumentKnowledge } = await import('@/services/ai/knowledge/document-knowledge.service');
    await persistDocumentKnowledge(buildKnowledgeFromSourceAnalysis({
      sourceGroup: { sourceIds: [fichier.id], leadSourceId: fichier.id }, document: {},
      assetCandidates: [], roomCandidates: [], equipmentCandidates: [], agendaCandidates: [], warnings: [],
      extractedFields: [{ fieldKey: 'kilometrage', value: 78000, confidence: 'certain', excerpt: '78 000 km' }],
      operationTrace: { traceIds: [], models: [], usedFallback: false } as never,
    }, {
      accountId: compte.id, fileId: fichier.id, analysisRunId: null, assetIdAtAnalysis: clio.id, sourceType: 'asset_file',
      // Confiance hors vocabulaire : refusée par la contrainte CHECK.
      operationCandidates: [{
        candidateKey: 'op1', established: true, confidence: 'incertaine' as never, typeHint: 'INTERVENTION', statusHint: 'REALIZED',
        summary: 'x', sourceRoleHint: 'INVOICE', provider: null, targetHints: [], businessReferences: [], temporalHints: {},
        financialHints: [], evidenceFactRefs: [], visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [],
      }],
    }));
    expect((await sql`SELECT id FROM document_facts WHERE file_id = ${fichier.id} AND status = 'active'`).length).toBe(1);
    expect((await candidats(fichier.id)).map((c) => c.status)).toEqual(['SUPERSEDED']);
  });

  it('C3-E2E-07 — connaissance construite hors T1 (liste de candidats absente) : candidats du fichier inchangés, aucun contrôle de schéma', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const fichier = await make.assetFile(compte, { assetId: clio.id });
    await analyser({ compte, bienId: clio.id, nom: 'Clio', fichierId: fichier.id, f: loadT1Fixture('t1-40-01-facture-reparation.json'), ids: { 12: clio.id } });
    const { buildKnowledgeFromSourceAnalysis } = await import('@/services/ai/knowledge/document-knowledge');
    const { persistDocumentKnowledge } = await import('@/services/ai/knowledge/document-knowledge.service');
    await persistDocumentKnowledge(buildKnowledgeFromSourceAnalysis({
      sourceGroup: { sourceIds: [fichier.id], leadSourceId: fichier.id }, document: {},
      assetCandidates: [], roomCandidates: [], equipmentCandidates: [], agendaCandidates: [], warnings: [],
      extractedFields: [], operationTrace: { traceIds: [], models: [], usedFallback: false } as never,
    }, { accountId: compte.id, fileId: fichier.id, analysisRunId: null, assetIdAtAnalysis: clio.id, sourceType: 'asset_file' }));
    expect((await candidats(fichier.id)).map((c) => c.status)).toEqual(['ACTIVE']);
  });
});
