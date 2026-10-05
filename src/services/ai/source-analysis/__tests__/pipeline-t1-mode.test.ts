/**
 * Pipeline T1 — prompt maître SEUL (lot 16b-3 ; CDC 15 §29, D-04).
 *
 *   · GROUP_UPLOAD + ANALYZE_DOCUMENT master, faits écrits par
 *     `persistProjectedFacts` sur leur cible ; crédits, lot, notification et
 *     événements aval ;
 *   · plus aucune lecture d'`AI_T1_ANALYSIS_MODE` ni de l'architecture de la
 *     version : une variable retirée encore posée est sans effet ;
 *   · échec du master : PAS de repli — sources en échec (`failedSourceIds`),
 *     rien persisté, aucun crédit consommé, aucune notification de réussite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SourceAnalysisResult, SourceInput } from '../types';

// ── Base simulée : toute requête renvoie une ligne neutre ───────────────────
const ligne = { id: 1000, state: 'PENDING', status: 'completed', title: null, name: 'Clio', category: 'VEHICULE', subtype: null, assetId: 12 };
function chaine(): unknown {
  const p: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(p, {
    get: (_t, prop) => {
      if (prop === 'then') return (res: (v: unknown) => void) => res([ligne]);
      return () => proxy;
    },
  });
  return proxy;
}
vi.mock('@/db', () => ({ db: { select: () => chaine(), insert: () => chaine(), update: () => chaine() } }));

const input: SourceInput = {
  sourceType: 'file', sourceIds: [1000], accountId: 1, userId: 2,
  mimeTypes: ['application/pdf'], displayNames: ['facture.pdf'], linkedAssetId: 12,
};
const resultat = (origine: string): SourceAnalysisResult => ({
  sourceGroup: { sourceIds: [1000], leadSourceId: 1000 },
  document: { title: { value: origine, confidence: 'certain', excerpt: '', location: {} } },
  assetCandidates: [{ entityId: 12, confidence: 'certain', score: 1, reason: '', excerpt: '', verified: true }],
  roomCandidates: [], equipmentCandidates: [],
  extractedFields: [{ fieldKey: 'mileage', value: 78000, confidence: 'certain', excerpt: '78 000 km' }],
  agendaCandidates: [], warnings: [],
  operationTrace: { traceIds: [], operationCodes: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostMicros: 0, totalDurationMs: 0, usedFallback: false, models: [] },
});

const m = vi.hoisted(() => ({
  groupUpload: vi.fn(), analyseGroupWithMaster: vi.fn(),
  persistProjectedFacts: vi.fn(), persistAnalysisResult: vi.fn(), emitSourceAnalyzed: vi.fn(),
  consumeAnalysisCredits: vi.fn(), notifyLotCompleted: vi.fn(),
  enqueueT3ForAffectedAssets: vi.fn(), writeMasterDocumentLinks: vi.fn(),
}));

vi.mock('@/services/commercial-model.service', () => ({
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: (...a: unknown[]) => m.consumeAnalysisCredits(...a),
}));
vi.mock('../adapters', () => ({ getSourceAdapter: () => ({ prepare: async () => input }) }));
vi.mock('../steps/group-upload.step', () => ({ groupUpload: (...a: unknown[]) => m.groupUpload(...a) }));
vi.mock('../master/rubric-rules', () => ({ loadAssetFamilies: async () => ['VEHICULE'] }));
vi.mock('../steps/persist-evidence.step', () => ({
  persistProjectedFacts: (...a: unknown[]) => m.persistProjectedFacts(...a),
}));
vi.mock('../master/analyse-group-master', () => ({ analyseGroupWithMaster: (...a: unknown[]) => m.analyseGroupWithMaster(...a) }));
vi.mock('../master/document-links', async (orig) => ({
  ...(await orig<typeof import('../master/document-links')>()),
  writeMasterDocumentLinks: (...a: unknown[]) => m.writeMasterDocumentLinks(...a),
}));
vi.mock('../master/reconciliation-fanout', () => ({
  enqueueT3ForAffectedAssets: (...a: unknown[]) => m.enqueueT3ForAffectedAssets(...a),
  enqueueT3ForAffectedEntities: async () => [],
}));
vi.mock('../persistence/analysis-result.repository', () => ({ persistAnalysisResult: (...a: unknown[]) => m.persistAnalysisResult(...a) }));
vi.mock('../events', () => ({ emitSourceAnalyzed: (...a: unknown[]) => m.emitSourceAnalyzed(...a) }));
vi.mock('../lot-notification', () => ({ notifyLotCompleted: (...a: unknown[]) => m.notifyLotCompleted(...a) }));
vi.mock('../stream/broadcast', () => ({ broadcast: () => {} }));
const knowledgeCtx = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../knowledge/document-knowledge', () => ({
  buildKnowledgeFromSourceAnalysis: (_r: unknown, c: Record<string, unknown>) => { knowledgeCtx.push(c); return {}; },
}));
vi.mock('../../knowledge/document-knowledge.service', () => ({ persistDocumentKnowledge: async () => {} }));
vi.mock('@/services/documents/apply-v2-classification.service', () => ({ applyV2Classification: async () => {} }));
vi.mock('@/services/documents/grouped-sources', () => ({ markSourcesGrouped: async () => {} }));
vi.mock('@/services/document-ai/fusion-detector', () => ({ detectFusionCandidates: async () => ({ hasCandidates: false }) }));

const { runSourceAnalysis } = await import('../pipeline');

const trace = resultat('x').operationTrace;
const ENV = ['AI_T1_ANALYSIS_MODE', 'AI_T1_SHADOW_SAMPLE_RATE', 'AI_UNIFIED_SOURCE_ANALYSIS', 'AI_RECONCILIATION_ENGINE'];
const lancer = (extra: Record<string, unknown> = {}) => runSourceAnalysis({
  sourceType: 'file', sourceIds: [1000], accountId: 1, userId: 2, linkedAssetId: 12, ...extra,
});

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.groupUpload.mockResolvedValue({ groups: [[0]], trace });
  m.analyseGroupWithMaster.mockResolvedValue({
    result: resultat('master'),
    facts: [{ canonicalKey: 'mileage', value: 78000, target: { targetType: 'ASSET', targetEntityId: 12, targetConfidence: 'certain' } }],
    projection: { multiAsset: true }, documentAssetId: 12, promptVersion: 't1_master_v1@cfg8:abcdef123456',
  });
  knowledgeCtx.length = 0;
  m.persistAnalysisResult.mockResolvedValue({ runId: 77, deduplicated: false, proposalCount: 0 });
  m.persistProjectedFacts.mockResolvedValue({ affectedAssetIds: [12, 13] });
  m.enqueueT3ForAffectedAssets.mockResolvedValue({ enqueued: [13] });
  m.writeMasterDocumentLinks.mockResolvedValue({ created: 0, removed: 0 });
  for (const f of [m.emitSourceAnalyzed, m.consumeAnalysisCredits, m.notifyLotCompleted]) f.mockResolvedValue(undefined);
  for (const k of ENV) delete process.env[k];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { for (const k of ENV) delete process.env[k]; });

/** Effets d'une analyse réussie (crédits, notification, moteurs aval). */
function effetsCommuns() {
  expect(m.consumeAnalysisCredits).toHaveBeenCalledWith(1, 1);
  expect(m.notifyLotCompleted).toHaveBeenCalledWith(expect.objectContaining({ accountId: 1, analysedCount: 1, failedCount: 0 }));
  expect(m.emitSourceAnalyzed).toHaveBeenCalledWith(expect.objectContaining({ accountId: 1, assetId: 12, leadSourceId: 1000 }));
}

describe('pipeline T1 — master seul', () => {
  it('GROUP_UPLOAD + ANALYZE_DOCUMENT master, faits écrits sur leur cible', async () => {
    const out = await lancer();
    expect(out).toMatchObject({ analysedCount: 1, failedSourceIds: [] });
    expect(m.groupUpload).toHaveBeenCalled();
    expect(m.analyseGroupWithMaster).toHaveBeenCalledTimes(1);
    expect(m.persistProjectedFacts).toHaveBeenCalledWith(expect.objectContaining({
      leadSourceId: 1000, analysisRunId: 77, facts: [{ canonicalKey: 'mileage', value: 78000, target: { targetType: 'ASSET', targetEntityId: 12, targetConfidence: 'certain' } }],
      // Version RÉELLEMENT résolue du master, pas le code en dur.
      promptVersion: 't1_master_v1@cfg8:abcdef123456',
    }));
    const run = m.persistAnalysisResult.mock.calls[0][0];
    expect(run.result.document.title.value).toBe('master');
    expect(run.master).toEqual({ masterPromptVersion: 't1_master_v1@cfg8:abcdef123456' });
    expect(m.writeMasterDocumentLinks).toHaveBeenCalledWith(expect.objectContaining({ accountId: 1, fileId: 1000 }));
    // Base de connaissance : multi-biens et version du master transmis.
    expect(knowledgeCtx[0]).toMatchObject({ multiAsset: true, promptVersion: 't1_master_v1@cfg8:abcdef123456' });
    effetsCommuns();
  });

  it('variables retirées encore posées (legacy / shadow) : sans effet, master seul', async () => {
    process.env.AI_T1_ANALYSIS_MODE = 'legacy';
    process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'legacy';
    process.env.AI_T1_SHADOW_SAMPLE_RATE = '1';
    process.env.AI_RECONCILIATION_ENGINE = 'legacy';
    await lancer();
    expect(m.analyseGroupWithMaster).toHaveBeenCalledTimes(1);
    effetsCommuns();
  });

  it('T3 mis en file pour CHAQUE bien touché, pas seulement le bien du document', async () => {
    await lancer();
    expect(m.enqueueT3ForAffectedAssets).toHaveBeenCalledWith({
      accountId: 1, userId: 2, leadSourceId: 1000, affectedAssetIds: [12, 13], documentAssetId: 12,
    });
  });

  it('aucun fait : persistProjectedFacts appelé quand même (supersede des anciennes preuves)', async () => {
    m.analyseGroupWithMaster.mockResolvedValue({
      result: resultat('master'), facts: [], projection: {}, documentAssetId: 12, promptVersion: 't1_master_v1@file',
    });
    await lancer();
    expect(m.persistProjectedFacts).toHaveBeenCalledWith(expect.objectContaining({ facts: [], analysisRunId: 77 }));
  });

  it('échec total du master : PAS de repli — source en échec, rien persisté, aucun crédit', async () => {
    m.analyseGroupWithMaster.mockRejectedValue(new Error('ALL_MODELS_FAILED'));
    const out = await lancer();
    expect(out).toMatchObject({ analysedCount: 0, failedSourceIds: [1000], results: [] });
    expect(out.skippedReason).toBeUndefined();
    expect(m.persistAnalysisResult).not.toHaveBeenCalled();
    expect(m.persistProjectedFacts).not.toHaveBeenCalled();
    expect(m.emitSourceAnalyzed).not.toHaveBeenCalled();
    // Facturation : rien pour un essai en échec (la reprise consommera une fois).
    expect(m.consumeAnalysisCredits).not.toHaveBeenCalled();
    expect(m.notifyLotCompleted).toHaveBeenCalledWith(expect.objectContaining({ analysedCount: 0, failedCount: 1 }));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('source 1000'), 'ALL_MODELS_FAILED');
  });

  it('revue 3a : sortie invalide sur toute la chaîne → échec DÉFINITIF (code conservé) ; panne fournisseur → transitoire', async () => {
    const { AiGatewayError } = await import('../../gateway/errors');
    m.analyseGroupWithMaster.mockRejectedValue(new AiGatewayError('ALL_MODELS_FAILED', 't1_analyze_document', 'Tous les modèles ont échoué.',
      { recoverable: true, lastFailureCode: 'INVALID_OUTPUT' }));
    expect(await lancer()).toMatchObject({ failedSourceIds: [1000], definitiveFailedSourceIds: [1000] });
    m.analyseGroupWithMaster.mockRejectedValue(new AiGatewayError('ALL_MODELS_FAILED', 't1_analyze_document', 'Tous les modèles ont échoué.',
      { recoverable: true, lastFailureCode: 'PROVIDER_UNAVAILABLE' }));
    expect(await lancer()).toMatchObject({ failedSourceIds: [1000], definitiveFailedSourceIds: [] });
    const { T1MasterAnalysisError } = await import('../pipeline');
    const e = new T1MasterAnalysisError('x', { lastFailureCode: 'INVALID_OUTPUT', definitive: true });
    expect([e.lastFailureCode, e.definitive]).toEqual(['INVALID_OUTPUT', true]);
  });

  it('revue 3a : clôture du lot / notification en panne après persistance → l’exécution n’échoue pas (pas de rappel du master)', async () => {
    m.notifyLotCompleted.mockRejectedValue(new Error('notifications indisponibles'));
    const out = await lancer({ guard: { assertActive: async () => {} } as never });
    expect(out).toMatchObject({ analysedCount: 1, failedSourceIds: [] });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('notification de fin de lot'), 'notifications indisponibles');
  });

  it('échec du master sur un groupe : les autres groupes du lot sont analysés et facturés seuls', async () => {
    m.groupUpload.mockResolvedValue({ groups: [[0], [0]], trace });
    m.analyseGroupWithMaster
      .mockRejectedValueOnce(new Error('sortie invalide'))
      .mockResolvedValueOnce({ result: resultat('master'), facts: [], projection: {}, documentAssetId: 12, promptVersion: 't1_master_v1@file' });
    const out = await lancer();
    expect(out).toMatchObject({ analysedCount: 1, failedSourceIds: [1000] });
    expect(m.consumeAnalysisCredits).toHaveBeenCalledWith(1, 1);
  });

  it('interruption (rollback) pendant l’appel : remontée telle quelle, aucune écriture d’échec', async () => {
    const { ExecutionCancelledError } = await import('../../queue/execution-control');
    m.analyseGroupWithMaster.mockRejectedValue(new ExecutionCancelledError('rollback'));
    await expect(lancer({ guard: { assertActive: async () => {} } as never })).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(m.notifyLotCompleted).not.toHaveBeenCalled();
  });

  it('un job annulé avant persistance n’écrit rien', async () => {
    const { ExecutionCancelledError } = await import('../../queue/execution-control');
    const guard = {
      assertActive: async (etape?: string) => { if (etape === 'persistance du résultat') throw new ExecutionCancelledError('rollback'); },
    };
    await expect(lancer({ guard: guard as never })).rejects.toBeTruthy();
    expect(m.persistAnalysisResult).not.toHaveBeenCalled();
  });
});
