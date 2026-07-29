/**
 * CDC §10.1 et §10.4 — l'aiguillage doit choisir UN moteur, jamais les deux.
 *
 * Ces tests portent sur la propriété qui rend la bascule sûre : quel que soit
 * l'appelant et quelle que soit la valeur du drapeau, exactement un moteur
 * s'exécute. C'est la garantie que les huit points d'appel du code applicatif
 * ne peuvent plus diverger.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const runSourceAnalysis = vi.fn();
const runUnifiedAnalysisPipeline = vi.fn();
const selectUserId = vi.fn();
const offUnified = vi.fn();
const offLegacy = vi.fn();
const registerUnified = vi.fn(() => offUnified);
const registerLegacy = vi.fn(() => offLegacy);

vi.mock('../pipeline', () => ({ runSourceAnalysis }));
vi.mock('../stream/broadcast', () => ({ registerStreamWriter: registerUnified }));
vi.mock('@/services/document-ai/unified-analysis-pipeline', () => ({
  runUnifiedAnalysisPipeline,
  registerStreamWriter: registerLegacy,
}));
vi.mock('@/db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => selectUserId() }) }),
    }),
  },
}));
vi.mock('@/db/schema', () => ({ assetFiles: { id: 'id', userId: 'user_id' } }));

const { analyzeFileSources, registerAnalysisStreamWriter, isUnifiedAnalysisActive, resetEntrypointWarnings } = await import('../entrypoint');

beforeEach(() => {
  vi.clearAllMocks();
  resetEntrypointWarnings();
  delete process.env.AI_UNIFIED_SOURCE_ANALYSIS;
  runSourceAnalysis.mockResolvedValue({ results: [], analysedCount: 1 });
  runUnifiedAnalysisPipeline.mockResolvedValue(undefined);
  selectUserId.mockResolvedValue([{ userId: 42 }]);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('choix du moteur', () => {
  it('utilise le moteur historique par défaut', async () => {
    await analyzeFileSources([1], 7);
    expect(runUnifiedAnalysisPipeline).toHaveBeenCalledWith([1], 7);
    expect(runSourceAnalysis).not.toHaveBeenCalled();
  });

  it('utilise le pipeline unifié une fois le drapeau à `enabled`', async () => {
    process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'enabled';
    await analyzeFileSources([1, 2], 7, { origin: 'test' });

    expect(runSourceAnalysis).toHaveBeenCalledTimes(1);
    expect(runSourceAnalysis.mock.calls[0][0]).toMatchObject({
      sourceType: 'file', sourceIds: [1, 2], accountId: 7, userId: 42,
    });
    expect(runUnifiedAnalysisPipeline).not.toHaveBeenCalled();
  });

  it('n\'exécute jamais les deux moteurs — interdiction de double écriture (§10.4)', async () => {
    for (const mode of ['legacy', 'shadow', 'enabled', 'valeur_inconnue']) {
      vi.clearAllMocks();
      process.env.AI_UNIFIED_SOURCE_ANALYSIS = mode;
      await analyzeFileSources([1], 7);
      const total = runSourceAnalysis.mock.calls.length + runUnifiedAnalysisPipeline.mock.calls.length;
      expect(total, `mode ${mode}`).toBe(1);
    }
  });

  it('traite `shadow` comme `legacy` et le signale — pas de mode observation ici', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'shadow';

    await analyzeFileSources([1], 7);

    expect(runUnifiedAnalysisPipeline).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('mode observation');
  });

  it('n\'avertit qu\'une fois du mode observation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'shadow';

    await analyzeFileSources([1], 7);
    await analyzeFileSources([2], 7);

    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('paramètres transmis', () => {
  beforeEach(() => { process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'enabled'; });

  it('utilise l\'utilisateur fourni sans interroger la base', async () => {
    await analyzeFileSources([1], 7, { userId: 99 });
    expect(selectUserId).not.toHaveBeenCalled();
    expect(runSourceAnalysis.mock.calls[0][0].userId).toBe(99);
  });

  it('déduit l\'utilisateur du premier fichier quand il n\'est pas fourni', async () => {
    await analyzeFileSources([5], 7);
    expect(runSourceAnalysis.mock.calls[0][0].userId).toBe(42);
  });

  it('abandonne proprement si aucun utilisateur n\'est résolu', async () => {
    selectUserId.mockResolvedValue([]);
    const outcome = await analyzeFileSources([5], 7);
    expect(outcome).toBeNull();
    expect(runSourceAnalysis).not.toHaveBeenCalled();
  });

  it('propage la non-facturation d\'une reprise technique', async () => {
    await analyzeFileSources([1], 7, { billable: false, userId: 1 });
    expect(runSourceAnalysis.mock.calls[0][0].billable).toBe(false);
  });
});

describe('robustesse', () => {
  it('ne fait rien sans fichier ni compte', async () => {
    expect(await analyzeFileSources([], 7)).toBeNull();
    expect(await analyzeFileSources([1], 0)).toBeNull();
    expect(runSourceAnalysis).not.toHaveBeenCalled();
    expect(runUnifiedAnalysisPipeline).not.toHaveBeenCalled();
  });

  it('ne lève jamais — les appelants sont en « fire and forget »', async () => {
    process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'enabled';
    runSourceAnalysis.mockRejectedValue(new Error('modèle indisponible'));

    await expect(analyzeFileSources([1], 7, { userId: 1 })).resolves.toBeNull();
  });

  it('ne lève pas davantage quand le moteur historique échoue', async () => {
    runUnifiedAnalysisPipeline.mockRejectedValue(new Error('base injoignable'));
    await expect(analyzeFileSources([1], 7)).resolves.toBeNull();
  });
});

describe('diffusion SSE', () => {
  it('s\'abonne aux DEUX registres — sans quoi le flux se tairait à la bascule', async () => {
    const writer = vi.fn();
    await registerAnalysisStreamWriter(12, writer);

    expect(registerUnified).toHaveBeenCalledWith(12, writer);
    expect(registerLegacy).toHaveBeenCalledWith(12, writer);
  });

  it('s\'abonne indépendamment du drapeau', async () => {
    for (const mode of ['legacy', 'enabled']) {
      vi.clearAllMocks();
      process.env.AI_UNIFIED_SOURCE_ANALYSIS = mode;
      await registerAnalysisStreamWriter(12, vi.fn());
      expect(registerUnified, `mode ${mode}`).toHaveBeenCalledOnce();
      expect(registerLegacy, `mode ${mode}`).toHaveBeenCalledOnce();
    }
  });

  it('désabonne des deux registres en une fois', async () => {
    const unregister = await registerAnalysisStreamWriter(12, vi.fn());
    unregister();

    expect(offUnified).toHaveBeenCalledOnce();
    expect(offLegacy).toHaveBeenCalledOnce();
  });
});

describe('lecture du moteur actif', () => {
  it('ne signale le pipeline unifié que sur `enabled`', () => {
    for (const [mode, expected] of [['legacy', false], ['shadow', false], ['enabled', true]] as const) {
      process.env.AI_UNIFIED_SOURCE_ANALYSIS = mode;
      expect(isUnifiedAnalysisActive(), `mode ${mode}`).toBe(expected);
    }
  });

  it('est faux en l\'absence de configuration', () => {
    delete process.env.AI_UNIFIED_SOURCE_ANALYSIS;
    expect(isUnifiedAnalysisActive()).toBe(false);
  });
});
