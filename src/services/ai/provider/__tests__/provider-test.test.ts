/**
 * Test de clé fournisseur — PROV-UI-03 (lot IA 2) : compatibilité avec les
 * modèles configurés, jetons réels de la génération tracés.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const traces: Array<Record<string, unknown>> = [];
vi.mock('../../telemetry/ai-trace.service', () => ({
  recordCallTrace: async (t: Record<string, unknown>) => { traces.push(t); },
}));

const operationnel: Array<Record<string, unknown>> = [];
vi.mock('../model-operational.service', () => ({
  recordOperationalCheck: async (p: Record<string, unknown>) => { operationnel.push(p); },
}));

const { testProviderKey, missingConfiguredModels } = await import('../provider-test.service');

const reponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => { vi.unstubAllGlobals(); traces.length = 0; operationnel.length = 0; });

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
      .mockResolvedValueOnce(reponse({ candidates: [{ content: { parts: [{ text: 'OK' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 } })));
    const r = await testProviderKey('secret', 'a', 1, 1, ['a']);
    expect(r.ok).toBe(true);
    expect(traces.at(-1)).toMatchObject({ inputTokens: 7, outputTokens: 2, billable: false, status: 'success' });
  });

  it('MOD-31 — le test de clé conserve l’état opérationnel du modèle testé (succès comme refus de génération), jamais la clé', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reponse({ models: [{ name: 'models/a' }] }))
      .mockResolvedValueOnce(reponse({ candidates: [{ content: { parts: [{ text: 'OK' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })));
    await testProviderKey('secret', 'a', 1, 1, ['a']);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reponse({ models: [{ name: 'models/b' }] }))
      .mockResolvedValueOnce(new Response('no longer available to new users', { status: 404 })));
    await testProviderKey('secret', 'b', 1, 1, ['b']);
    // Lot 49 : issue CLASSÉE — retrait explicite (404 « no longer available ») = échec définitif du modèle.
    expect(operationnel).toEqual([
      { model: 'a', secret: 'secret', outcome: { status: 'ok' }, source: 'provider_test' },
      expect.objectContaining({
        model: 'b', source: 'provider_test',
        outcome: expect.objectContaining({ status: 'failed', kind: 'model_retired', definitive: true, error: expect.stringMatching(/no longer available/) }),
      }),
    ]);
  });

  it('T11-AC03 / T11-AC04 / T11-AC08 — test de clé : réponse vide et clé refusée non concluantes ; génération à 512 jetons, raisonnement minimal', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(reponse({ models: [{ name: 'models/gemini-3.6-flash' }] }))
      .mockResolvedValueOnce(reponse({ candidates: [{ content: { parts: [{ text: '', thought: false }] } }] }));
    vi.stubGlobal('fetch', f);
    await testProviderKey('secret', 'gemini-3.6-flash', 1, 1, ['gemini-3.6-flash']);
    const corps = JSON.parse(String((f.mock.calls[1][1] as RequestInit).body));
    expect(corps.generationConfig).toMatchObject({ maxOutputTokens: 512, thinkingConfig: { thinkingLevel: 'low' } });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reponse({ models: [{ name: 'models/gemini-3.6-flash' }] }))
      .mockResolvedValueOnce(new Response('{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"API key not valid. key=secret"}}', { status: 400 })));
    await testProviderKey('secret', 'gemini-3.6-flash', 1, 1, ['gemini-3.6-flash']);
    expect(operationnel.map((o) => (o.outcome as { status: string; kind?: string }))).toEqual([
      expect.objectContaining({ status: 'inconclusive', kind: 'empty_response' }),
      expect.objectContaining({ status: 'inconclusive', kind: 'auth_global' }),
    ]);
    expect(JSON.stringify(operationnel.map((o) => o.outcome))).not.toContain('key=secret');
  });
});
