/**
 * Revue L16b-3a — échecs de l'analyse T1 :
 *   · point 1 / 2 : échec DÉFINITIF (sortie invalide sur toute la chaîne) →
 *     une seule reprise, puis le job est clos (borne de coût, disjoncteur
 *     jamais atteint par un seul document) ; échec transitoire inchangé ;
 *   · point 3 : un LIEN WEB (`is_web_link`) passé au point d'entrée fichier
 *     (file durable, reprise serveur, tiroir) est analysé par l'adaptateur
 *     lien web, jamais comme un fichier vide.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const run = vi.hoisted(() => vi.fn());
const analyze = vi.hoisted(() => vi.fn());
const handlers = vi.hoisted(() => new Map<string, (job: unknown, guard: unknown) => Promise<void>>());
const rows = vi.hoisted(() => ({ value: [] as Array<{ id: number; isWebLink: boolean }> }));

vi.mock('../pipeline', () => ({ runSourceAnalysis: (...a: unknown[]) => run(...a) }));
vi.mock('@/db', () => {
  const chain = { from: () => chain, where: async () => rows.value };
  return { db: { select: () => chain }, pgClient: { unsafe: async () => [] } };
});
vi.mock('../../queue/queue-worker', () => ({
  registerJobHandler: (t: string, h: (job: unknown, guard: unknown) => Promise<void>) => { handlers.set(t, h); },
  nudgeQueueWorker: () => {},
}));
vi.mock('../../queue/job-queue.repository', () => ({ enqueue: async () => ({ decision: 'create' }) }));

const { isDefinitiveGatewayFailure, MAX_ANALYSIS_RETRIES } = await import('../failure-policy');
const { analyzeFileSources } = await import('../entrypoint');

beforeEach(() => {
  run.mockReset();
  analyze.mockReset();
  rows.value = [];
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('politique d’échec (points 1 et 2)', () => {
  it('définitif : dernier modèle en sortie invalide, ou prompt maître invalide ; le reste est transitoire', () => {
    expect(isDefinitiveGatewayFailure({ code: 'ALL_MODELS_FAILED', lastFailureCode: 'INVALID_OUTPUT' })).toBe(true);
    expect(isDefinitiveGatewayFailure({ code: 'MASTER_PROMPT_INVALID' })).toBe(true);
    expect(isDefinitiveGatewayFailure({ code: 'ALL_MODELS_FAILED', lastFailureCode: 'PROVIDER_UNAVAILABLE' })).toBe(false);
    expect(isDefinitiveGatewayFailure({ code: 'ALL_MODELS_FAILED', lastFailureCode: 'TIMEOUT' })).toBe(false);
    expect(isDefinitiveGatewayFailure(new Error('x'))).toBe(false);
    expect(isDefinitiveGatewayFailure(null)).toBe(false);
    expect(MAX_ANALYSIS_RETRIES).toBe(10);
  });
  // Plafond de la reprise serveur et compteur porté au plafond par le
  // pipeline : vérifiés à l'exécution sur PostgreSQL (`l16b-t3-master.e2e.ts`).
});

describe('exécutant T1 : une seule reprise pour un échec définitif', () => {
  const garde = { assertActive: async () => {} };
  const job = (over: Record<string, unknown> = {}) => ({
    id: 9, accountId: 5, targetType: 'asset_file', targetId: '42', attempts: 1, recoveredCount: 0,
    payload: { fileId: 42, userId: 3, origin: 'files/confirm' }, ...over,
  });
  const lancer = async (outcome: unknown, j = job()) => {
    vi.resetModules();
    vi.doMock('../entrypoint', () => ({ analyzeFileSources: async () => outcome }));
    const { registerSourceAnalysisHandler } = await import('../queue/t1-handler');
    registerSourceAnalysisHandler();
    return handlers.get('T1')!(j, garde);
  };
  const definitif = { results: [], analysedCount: 0, failedSourceIds: [42], definitiveFailedSourceIds: [42] };
  const transitoire = { results: [], analysedCount: 0, failedSourceIds: [42], definitiveFailedSourceIds: [] };

  it('premier essai en échec définitif : le job échoue (une reprise)', async () => {
    await expect(lancer(definitif)).rejects.toThrow(/en échec/);
  });

  it('second essai en échec définitif : job clos sans nouvelle tentative', async () => {
    // Lot 33D (cas 7) : job DONE, mais résultat MÉTIER en échec — jamais lisible comme une réussite.
    await expect(lancer(definitif, job({ attempts: 2 }))).resolves.toMatchObject({ result: 'FAILED', detail: { fileId: 42 } });
  });

  it('remise en file après un échec hors file (`:reprise`) = la reprise : close dès le premier essai', async () => {
    await expect(lancer(definitif, job({ payload: { fileId: 42, origin: 'documents/analyze:reprise' } }))).resolves.toMatchObject({ result: 'FAILED' });
  });

  it('échec transitoire : toujours repris par la file (backoff), même au second essai', async () => {
    await expect(lancer(transitoire, job({ attempts: 2 }))).rejects.toThrow(/en échec/);
  });
});

describe('lien web passé au point d’entrée fichier (point 3)', () => {
  it('chaque lien est analysé en `web_link`, les fichiers en `file` ; issues fusionnées', async () => {
    rows.value = [{ id: 42, isWebLink: true }, { id: 43, isWebLink: false }];
    run.mockImplementation(async (req: { sourceIds: number[] }) => ({
      results: [], analysedCount: 1, failedSourceIds: [], definitiveFailedSourceIds: [], ids: req.sourceIds,
    }));
    const r = await analyzeFileSources([42, 43], 5, { userId: 3, origin: 'analysis-recovery', guard: { assertActive: async () => {} } as never });
    expect(run.mock.calls.map((c) => [(c[0] as { sourceType: string }).sourceType, (c[0] as { sourceIds: number[] }).sourceIds]))
      .toEqual([['file', [43]], ['web_link', [42]]]);
    expect(r).toMatchObject({ analysedCount: 2, failedSourceIds: [] });
  });

  it('lien web en échec hors file : remis en file durable comme un fichier (aiguillé à l’exécution)', async () => {
    rows.value = [{ id: 42, isWebLink: true }];
    run.mockResolvedValue({ results: [], analysedCount: 0, failedSourceIds: [42] });
    const enqueue = vi.fn(async () => [42]);
    vi.doUnmock('../entrypoint');
    vi.doMock('../queue/t1-handler', () => ({ enqueueFileAnalyses: enqueue }));
    vi.resetModules();
    const { analyzeFileSources: entree } = await import('../entrypoint');
    await entree([42], 5, { userId: 3, origin: 'documents/analyze' });
    expect((run.mock.calls[0][0] as { sourceType: string }).sourceType).toBe('web_link');
    expect(enqueue).toHaveBeenCalledWith([42], 5, expect.objectContaining({ origin: 'documents/analyze:reprise' }));
    vi.doUnmock('../queue/t1-handler');
  });

  it('type explicite (corpus) : aucun aiguillage', async () => {
    rows.value = [{ id: 42, isWebLink: true }];
    run.mockResolvedValue({ results: [], analysedCount: 1, failedSourceIds: [] });
    await analyzeFileSources([42], 5, { userId: 3, sourceType: 'future_source', retryOnFailure: false });
    expect((run.mock.calls[0][0] as { sourceType: string }).sourceType).toBe('future_source');
  });
});
