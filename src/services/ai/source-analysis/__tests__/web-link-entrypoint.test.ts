/**
 * Aiguillage des liens web — CDC §4.1.7 et §10.4.
 *
 * Ce test verrouille la correction du lot 0 : la route d'analyse des liens web
 * appelait le moteur directement, court-circuitant l'aiguillage. Avec le
 * drapeau à `legacy`, un fichier partait sur le moteur historique et un lien
 * web sur le nouveau — deux schémas de sortie pour le même compte.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runSourceAnalysis = vi.fn();

vi.mock('@/services/ai/source-analysis/pipeline', () => ({ runSourceAnalysis }));
vi.mock('@/db', () => ({ db: {} }));
vi.mock('@/db/schema', () => ({ assetFiles: {} }));

describe('analyzeWebLinkSource', () => {
  beforeEach(() => {
    runSourceAnalysis.mockReset();
    runSourceAnalysis.mockResolvedValue({ results: [], skippedReason: null });
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.AI_UNIFIED_SOURCE_ANALYSIS;
  });

  it('transmet le lien au moteur avec le bon type de source', async () => {
    process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'enabled';
    const { analyzeWebLinkSource } = await import('@/services/ai/source-analysis/entrypoint');

    await analyzeWebLinkSource(42, 7, { userId: 3 });

    expect(runSourceAnalysis).toHaveBeenCalledTimes(1);
    expect(runSourceAnalysis).toHaveBeenCalledWith({
      sourceType: 'web_link',
      sourceIds: [42],
      accountId: 7,
      userId: 3,
    });
  });

  it('analyse le lien même lorsque le drapeau vaut legacy', async () => {
    // Le lien web n'a pas de moteur historique : sa logique propre a été
    // supprimée au lot 1. Le refuser casserait une fonctionnalité qui marche.
    process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'legacy';
    const { analyzeWebLinkSource } = await import('@/services/ai/source-analysis/entrypoint');

    await analyzeWebLinkSource(42, 7, { userId: 3 });

    expect(runSourceAnalysis).toHaveBeenCalledTimes(1);
  });

  it('signale l’écart une seule fois, pas à chaque analyse', async () => {
    process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'legacy';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { analyzeWebLinkSource } = await import('@/services/ai/source-analysis/entrypoint');

    await analyzeWebLinkSource(1, 7, { userId: 3 });
    await analyzeWebLinkSource(2, 7, { userId: 3 });
    await analyzeWebLinkSource(3, 7, { userId: 3 });

    const drift = info.mock.calls.filter((c) => String(c[0]).includes('pas de moteur historique'));
    expect(drift).toHaveLength(1);
    info.mockRestore();
  });

  it('ne signale rien lorsque le drapeau est basculé', async () => {
    process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'enabled';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { analyzeWebLinkSource } = await import('@/services/ai/source-analysis/entrypoint');

    await analyzeWebLinkSource(1, 7, { userId: 3 });

    const drift = info.mock.calls.filter((c) => String(c[0]).includes('pas de moteur historique'));
    expect(drift).toHaveLength(0);
    info.mockRestore();
  });

  it('remonte le résultat du moteur à l’appelant', async () => {
    process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'enabled';
    runSourceAnalysis.mockResolvedValue({
      results: [{ document: { id: 9 }, warnings: [], agendaCandidates: [] }],
      skippedReason: null,
    });
    const { analyzeWebLinkSource } = await import('@/services/ai/source-analysis/entrypoint');

    const outcome = await analyzeWebLinkSource(42, 7, { userId: 3 });

    // Contrairement à `analyzeFileSources`, cette fonction NE capture PAS les
    // erreurs : son appelant est une route HTTP qui doit pouvoir répondre 402
    // sur quota ou 404 sur source indisponible.
    expect(outcome.results[0].document).toEqual({ id: 9 });
  });
});
