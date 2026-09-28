/**
 * Test de clé fournisseur — PROV-UI-03 (lot IA 2) : compatibilité avec les
 * modèles configurés, jetons réels de la génération tracés.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const traces: Array<Record<string, unknown>> = [];
vi.mock('../../telemetry/ai-trace.service', () => ({
  recordCallTrace: async (t: Record<string, unknown>) => { traces.push(t); },
}));

const { testProviderKey, missingConfiguredModels } = await import('../provider-test.service');

const reponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => { vi.unstubAllGlobals(); traces.length = 0; });

describe('missingConfiguredModels', () => {
  it('compare sans le préfixe « models/ »', () => {
    expect(missingConfiguredModels(['models/a', 'models/b'], ['a', 'c'])).toEqual(['c']);
  });
});

describe('testProviderKey', () => {
  it('clé qui ne sert pas un modèle configuré : échec explicite, sans génération', async () => {
    const f = vi.fn().mockResolvedValueOnce(reponse({ models: [{ name: 'models/a' }] }));
    vi.stubGlobal('fetch', f);
    const r = await testProviderKey('secret', 'a', 1, 1, ['a', 'b']);
    expect(r.ok).toBe(false);
    expect(r.detail.missingModels).toEqual(['b']);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('clé compatible : génération, jetons réels tracés en coût technique', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reponse({ models: [{ name: 'models/a' }] }))
      .mockResolvedValueOnce(reponse({ usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 } })));
    const r = await testProviderKey('secret', 'a', 1, 1, ['a']);
    expect(r.ok).toBe(true);
    expect(traces.at(-1)).toMatchObject({ inputTokens: 7, outputTokens: 2, billable: false, status: 'success' });
  });
});
