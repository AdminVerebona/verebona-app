/**
 * Commutateur `AI_T1_ANALYSIS_MODE` dans le pipeline — CDC 15 §29, D-04,
 * D-18 ; plan § Déploiement.
 *
 *   · legacy (défaut) : chemin historique, aucune lecture de configuration
 *     master, aucune exécution master ;
 *   · shadow : chemin historique + observation sur échantillon, rien persisté
 *     par le master ;
 *   · enabled : master seulement si la version de configuration déclare T1 en
 *     `master` ; faits écrits par `persistProjectedFacts` ; crédits, lot,
 *     notification et événements aval identiques.
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
  groupSources: vi.fn(), groupUpload: vi.fn(), extractSource: vi.fn(), classifyDocument: vi.fn(),
  identifyEntities: vi.fn(), classifyRubric: vi.fn(), analyseGroupWithMaster: vi.fn(), scheduleT1Shadow: vi.fn(),
  persistEvidence: vi.fn(), persistProjectedFacts: vi.fn(), persistAnalysisResult: vi.fn(), emitSourceAnalyzed: vi.fn(),
  consumeAnalysisCredits: vi.fn(), notifyLotCompleted: vi.fn(), getPromptArchitecture: vi.fn(),
  enqueueT3ForAffectedAssets: vi.fn(), writeMasterDocumentLinks: vi.fn(),
}));

vi.mock('@/services/commercial-model.service', () => ({
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: (...a: unknown[]) => m.consumeAnalysisCredits(...a),
}));
vi.mock('../adapters', () => ({ getSourceAdapter: () => ({ prepare: async () => input }) }));
vi.mock('../steps/group-sources.step', () => ({ groupSources: (...a: unknown[]) => m.groupSources(...a) }));
vi.mock('../steps/group-upload.step', () => ({ groupUpload: (...a: unknown[]) => m.groupUpload(...a) }));
vi.mock('../steps/extract-source.step', () => ({ extractSource: (...a: unknown[]) => m.extractSource(...a) }));
vi.mock('../steps/classify-document.step', () => ({ classifyDocument: (...a: unknown[]) => m.classifyDocument(...a) }));
vi.mock('../steps/identify-entities.step', () => ({ identifyEntities: (...a: unknown[]) => m.identifyEntities(...a) }));
vi.mock('../steps/classify-rubric.step', () => ({
  classifyRubric: (...a: unknown[]) => m.classifyRubric(...a), loadAssetFamilies: async () => ['VEHICULE'],
}));
vi.mock('../steps/persist-evidence.step', () => ({
  persistEvidence: (...a: unknown[]) => m.persistEvidence(...a),
  persistProjectedFacts: (...a: unknown[]) => m.persistProjectedFacts(...a),
}));
vi.mock('../master/analyse-group-master', () => ({ analyseGroupWithMaster: (...a: unknown[]) => m.analyseGroupWithMaster(...a) }));
vi.mock('../master/document-links', async (orig) => ({
  ...(await orig<typeof import('../master/document-links')>()),
  writeMasterDocumentLinks: (...a: unknown[]) => m.writeMasterDocumentLinks(...a),
}));
vi.mock('../master/reconciliation-fanout', () => ({ enqueueT3ForAffectedAssets: (...a: unknown[]) => m.enqueueT3ForAffectedAssets(...a) }));
vi.mock('../master/shadow', () => ({ scheduleT1Shadow: (...a: unknown[]) => m.scheduleT1Shadow(...a) }));
vi.mock('@/services/ai/config/prompt-architecture', () => ({ getPromptArchitecture: (...a: unknown[]) => m.getPromptArchitecture(...a) }));
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
const ENV = ['AI_T1_ANALYSIS_MODE', 'AI_T1_SHADOW_SAMPLE_RATE'];

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.groupSources.mockResolvedValue({ groups: [[0]], trace });
  m.groupUpload.mockResolvedValue({ groups: [[0]], trace });
  m.extractSource.mockResolvedValue({ document: resultat('legacy').document, extractedFields: resultat('legacy').extractedFields, warnings: [], trace });
  m.classifyDocument.mockResolvedValue({ trace });
  m.identifyEntities.mockResolvedValue({ ...resultat('legacy'), warnings: [], trace });
  m.classifyRubric.mockResolvedValue(null);
  m.analyseGroupWithMaster.mockResolvedValue({
    result: resultat('master'),
    facts: [{ canonicalKey: 'mileage', value: 78000, target: { targetType: 'ASSET', targetEntityId: 12, targetConfidence: 'certain' } }],
    projection: { multiAsset: true }, documentAssetId: 12, promptVersion: 't1_master_v1@cfg8:abcdef123456',
  });
  knowledgeCtx.length = 0;
  m.persistAnalysisResult.mockResolvedValue({ runId: 77, deduplicated: false, proposalCount: 0 });
  m.persistProjectedFacts.mockResolvedValue({ affectedAssetIds: [12, 13] });
  m.enqueueT3ForAffectedAssets.mockResolvedValue({ enqueued: [13], legacy: [] });
  m.writeMasterDocumentLinks.mockResolvedValue({ created: 0, removed: 0 });
  m.getPromptArchitecture.mockResolvedValue('master');
  for (const f of [m.persistEvidence, m.emitSourceAnalyzed, m.consumeAnalysisCredits, m.notifyLotCompleted]) f.mockResolvedValue(undefined);
  for (const k of ENV) delete process.env[k];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { for (const k of ENV) delete process.env[k]; });

/** Effets communs aux trois chemins (crédits, notification, moteurs aval). */
function effetsCommuns() {
  expect(m.consumeAnalysisCredits).toHaveBeenCalledWith(1, 1);
  expect(m.notifyLotCompleted).toHaveBeenCalledWith(expect.objectContaining({ accountId: 1, analysedCount: 1, failedCount: 0 }));
  expect(m.emitSourceAnalyzed).toHaveBeenCalledWith(expect.objectContaining({ accountId: 1, assetId: 12, leadSourceId: 1000 }));
}

describe('AI_T1_ANALYSIS_MODE', () => {
  it('legacy (défaut) : chemin historique seul, configuration master jamais lue', async () => {
    const out = await runSourceAnalysis({ sourceType: 'file', sourceIds: [1000], accountId: 1, userId: 2, linkedAssetId: 12 });
    expect(out.analysedCount).toBe(1);
    expect(m.groupSources).toHaveBeenCalled();
    expect(m.extractSource).toHaveBeenCalled();
    expect(m.persistEvidence).toHaveBeenCalledWith(expect.objectContaining({ assetId: 12 }));
    expect(m.getPromptArchitecture).not.toHaveBeenCalled();
    expect(knowledgeCtx[0]).not.toHaveProperty('multiAsset');
    // Legacy : aucune écriture de lien hors déclencheur.
    expect(m.writeMasterDocumentLinks).not.toHaveBeenCalled();
    expect(m.groupUpload).not.toHaveBeenCalled();
    expect(m.analyseGroupWithMaster).not.toHaveBeenCalled();
    expect(m.persistProjectedFacts).not.toHaveBeenCalled();
    expect(m.scheduleT1Shadow).not.toHaveBeenCalled();
    effetsCommuns();
  });

  it('valeur invalide : lue legacy', async () => {
    process.env.AI_T1_ANALYSIS_MODE = 'on';
    await runSourceAnalysis({ sourceType: 'file', sourceIds: [1000], accountId: 1, userId: 2, linkedAssetId: 12 });
    expect(m.analyseGroupWithMaster).not.toHaveBeenCalled();
    expect(m.scheduleT1Shadow).not.toHaveBeenCalled();
  });

  it('shadow échantillonné : historique persisté, master observé sur le résultat historique, rien écrit par le master', async () => {
    process.env.AI_T1_ANALYSIS_MODE = 'shadow';
    process.env.AI_T1_SHADOW_SAMPLE_RATE = '1';
    await runSourceAnalysis({ sourceType: 'file', sourceIds: [1000], accountId: 1, userId: 2, linkedAssetId: 12 });
    expect(m.extractSource).toHaveBeenCalled();
    expect(m.persistEvidence).toHaveBeenCalled();
    expect(m.scheduleT1Shadow).toHaveBeenCalledTimes(1);
    expect(m.scheduleT1Shadow.mock.calls[0][0]).toMatchObject({ groupIndices: [0], legacy: { document: { title: { value: 'legacy' } } } });
    expect(m.persistProjectedFacts).not.toHaveBeenCalled();
    expect(m.getPromptArchitecture).not.toHaveBeenCalled();
    effetsCommuns();
  });

  it('shadow hors échantillon : aucune observation', async () => {
    process.env.AI_T1_ANALYSIS_MODE = 'shadow';
    process.env.AI_T1_SHADOW_SAMPLE_RATE = '0';
    await runSourceAnalysis({ sourceType: 'file', sourceIds: [1000], accountId: 1, userId: 2, linkedAssetId: 12 });
    expect(m.scheduleT1Shadow).not.toHaveBeenCalled();
  });

  it('enabled mais version de configuration en « steps » : chemin historique', async () => {
    process.env.AI_T1_ANALYSIS_MODE = 'enabled';
    m.getPromptArchitecture.mockResolvedValue('steps');
    await runSourceAnalysis({ sourceType: 'file', sourceIds: [1000], accountId: 1, userId: 2, linkedAssetId: 12 });
    expect(m.getPromptArchitecture).toHaveBeenCalledWith('T1');
    expect(m.extractSource).toHaveBeenCalled();
    expect(m.analyseGroupWithMaster).not.toHaveBeenCalled();
    effetsCommuns();
  });

  it('enabled et version « master » : GROUP_UPLOAD + ANALYZE_DOCUMENT master, faits écrits sur leur cible', async () => {
    process.env.AI_T1_ANALYSIS_MODE = 'enabled';
    await runSourceAnalysis({ sourceType: 'file', sourceIds: [1000], accountId: 1, userId: 2, linkedAssetId: 12 });
    expect(m.groupUpload).toHaveBeenCalled();
    expect(m.groupSources).not.toHaveBeenCalled();
    expect(m.extractSource).not.toHaveBeenCalled();
    expect(m.analyseGroupWithMaster).toHaveBeenCalledTimes(1);
    expect(m.persistEvidence).not.toHaveBeenCalled();
    expect(m.persistProjectedFacts).toHaveBeenCalledWith(expect.objectContaining({
      leadSourceId: 1000, analysisRunId: 77, facts: [{ canonicalKey: 'mileage', value: 78000, target: { targetType: 'ASSET', targetEntityId: 12, targetConfidence: 'certain' } }],
      // Version RÉELLEMENT résolue du master, pas le code en dur.
      promptVersion: 't1_master_v1@cfg8:abcdef123456',
    }));
    const run = m.persistAnalysisResult.mock.calls[0][0];
    expect(run.result.document.title.value).toBe('master');
    expect(run.master).toEqual({ masterPromptVersion: 't1_master_v1@cfg8:abcdef123456' });
    expect(m.writeMasterDocumentLinks).toHaveBeenCalledWith(expect.objectContaining({ accountId: 1, fileId: 1000 }));
    // Base de connaissance : multi-biens transmis en master.
    expect(knowledgeCtx[0]).toMatchObject({ multiAsset: true });
    effetsCommuns();
  });

  it('enabled : T3 mis en file pour CHAQUE bien touché, pas seulement le bien du document', async () => {
    process.env.AI_T1_ANALYSIS_MODE = 'enabled';
    await runSourceAnalysis({ sourceType: 'file', sourceIds: [1000], accountId: 1, userId: 2, linkedAssetId: 12 });
    expect(m.enqueueT3ForAffectedAssets).toHaveBeenCalledWith({
      accountId: 1, userId: 2, leadSourceId: 1000, affectedAssetIds: [12, 13], documentAssetId: 12,
    });
  });

  it('enabled, aucun fait : persistProjectedFacts appelé quand même (supersede des anciennes preuves)', async () => {
    process.env.AI_T1_ANALYSIS_MODE = 'enabled';
    m.analyseGroupWithMaster.mockResolvedValue({
      result: resultat('master'), facts: [], projection: {}, documentAssetId: 12, promptVersion: 't1_master_v1@file',
    });
    await runSourceAnalysis({ sourceType: 'file', sourceIds: [1000], accountId: 1, userId: 2, linkedAssetId: 12 });
    expect(m.persistProjectedFacts).toHaveBeenCalledWith(expect.objectContaining({ facts: [], analysisRunId: 77 }));
  });

  it('enabled, échec total du master : repli sur les étapes pour ce groupe, avertissement', async () => {
    process.env.AI_T1_ANALYSIS_MODE = 'enabled';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.analyseGroupWithMaster.mockRejectedValue(new Error('ALL_MODELS_FAILED'));
    const out = await runSourceAnalysis({ sourceType: 'file', sourceIds: [1000], accountId: 1, userId: 2, linkedAssetId: 12 });
    expect(out.analysedCount).toBe(1);
    expect(m.extractSource).toHaveBeenCalled();
    expect(m.persistEvidence).toHaveBeenCalled();
    expect(m.persistProjectedFacts).not.toHaveBeenCalled();
    const run = m.persistAnalysisResult.mock.calls[0][0];
    expect(run.master).toBeUndefined();
    expect(run.result.warnings).toContainEqual(expect.objectContaining({ code: 'MASTER_FALLBACK_STEPS', target: 't1-master:fallback-steps' }));
    expect(console.warn).toHaveBeenCalled();
    effetsCommuns();
  });

  it('shadow : un job annulé avant persistance n’appelle pas le master', async () => {
    process.env.AI_T1_ANALYSIS_MODE = 'shadow';
    process.env.AI_T1_SHADOW_SAMPLE_RATE = '1';
    const { ExecutionCancelledError } = await import('../../queue/execution-control');
    const guard = {
      assertActive: async (etape?: string) => { if (etape === 'persistance du résultat') throw new ExecutionCancelledError('rollback'); },
    };
    await expect(runSourceAnalysis({
      sourceType: 'file', sourceIds: [1000], accountId: 1, userId: 2, linkedAssetId: 12, guard: guard as never,
    })).rejects.toBeTruthy();
    expect(m.scheduleT1Shadow).not.toHaveBeenCalled();
  });

  it('shadow en production : ignoré (D-18), comportement legacy', async () => {
    process.env.AI_T1_ANALYSIS_MODE = 'shadow';
    process.env.AI_T1_SHADOW_SAMPLE_RATE = '1';
    const avant = process.env.NEXT_PUBLIC_APP_ENV;
    process.env.NEXT_PUBLIC_APP_ENV = 'production';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runSourceAnalysis({ sourceType: 'file', sourceIds: [1000], accountId: 1, userId: 2, linkedAssetId: 12 });
    } finally {
      if (avant === undefined) delete process.env.NEXT_PUBLIC_APP_ENV; else process.env.NEXT_PUBLIC_APP_ENV = avant;
    }
    expect(m.scheduleT1Shadow).not.toHaveBeenCalled();
    expect(m.extractSource).toHaveBeenCalled();
  });
});
