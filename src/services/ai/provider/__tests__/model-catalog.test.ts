/**
 * Catalogue des modèles du fournisseur — E-04, PROV-UI-06 à 08, WF-29, WF-40.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: Array<{ sql: string; params: unknown[] }> = [];
let respond: (sql: string) => unknown[] = () => [];
vi.mock('@/db', () => ({
  pgClient: { unsafe: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return respond(sql); } },
}));
let secret: string | null = 'cle';
vi.mock('../provider-secret', () => ({ getProviderSecret: async () => secret }));

const { parseModelsListing, refreshModelCatalog, selectableModels } = await import('../model-catalog.service');

beforeEach(() => { calls.length = 0; respond = () => []; secret = 'cle'; vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'info').mockImplementation(() => {}); });

const listing = {
  models: [
    { name: 'models/gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1_000_000, outputTokenLimit: 65_536, thinking: true },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
  ],
};

describe('lecture du listing', () => {
  it('ne retient que les modèles Gemini de génération', () => {
    expect(parseModelsListing(listing)).toEqual([{
      model: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', supportsGeneration: true,
      supportsThinking: true, inputTokenLimit: 1_000_000, outputTokenLimit: 65_536,
    }]);
    expect(parseModelsListing(null)).toEqual([]);
  });
});

describe('rafraîchissement', () => {
  it('enregistre les modèles listés et marque les disparus indisponibles', async () => {
    respond = (sql) => (sql.includes('SET available = FALSE') ? [{ model: 'gemini-2.5-flash-lite' }] : []);
    const fetcher = vi.fn(async () => new Response(JSON.stringify(listing), { status: 200 }));
    const r = await refreshModelCatalog(1, fetcher as never);
    expect(r).toEqual({ ok: true, modelsSeen: 1, disappeared: ['gemini-2.5-flash-lite'] });
    // Clé en en-tête, jamais dans l'URL (journaux).
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('cle');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('cle');
    expect(calls.some((c) => c.sql.includes('INSERT INTO ai_model_catalog\n'))).toBe(true);
  });

  it('WF-40 : en échec, le catalogue précédent est conservé (aucune écriture de modèles)', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 403 }));
    const r = await refreshModelCatalog(1, fetcher as never);
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.sql.includes('SET available = FALSE'))).toBe(false);
    expect(calls.some((c) => c.sql.includes('ai_model_catalog_refresh') && c.sql.includes('ok = FALSE'))).toBe(true);
  });

  it('sans clé active : échec explicite', async () => {
    secret = null;
    expect((await refreshModelCatalog(1, vi.fn() as never)).error).toMatch(/clé/);
  });
});

describe('modèles sélectionnables', () => {
  it('jamais rafraîchi : catalogue du code ; sinon seuls les disponibles', () => {
    expect([...selectableModels(['a', 'b'], { refreshedAt: null, models: [] })]).toEqual(['a', 'b']);
    const s = selectableModels(['a', 'b'], {
      refreshedAt: '2026-09-26T00:00:00Z',
      models: [{ model: 'a', available: false }, { model: 'c', available: true }] as never,
    });
    expect([...s]).toEqual(['c']);
  });
});
