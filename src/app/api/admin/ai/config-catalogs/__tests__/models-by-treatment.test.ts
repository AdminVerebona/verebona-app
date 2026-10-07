/**
 * Lot 32B — `GET /api/admin/ai/config-catalogs` : une liste de modèles PAR
 * TRAITEMENT (`modelsByTreatment`, calculée par `usableModelsForTreatment`),
 * sans aucun appel fournisseur pour l'afficher.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../config-versions/_shared', async (orig) => ({
  ...(await orig<typeof import('../../config-versions/_shared')>()),
  requireAdminContext: async () => ({ ok: true, ctx: { adminUserId: 1 } }),
}));
const listes = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-2.5-pro', 'gemini-3.1-pro-preview'];
vi.mock('@/services/ai/provider/model-catalog.service', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/provider/model-catalog.service')>()),
  getCatalogState: async () => ({
    refreshedAt: '2026-10-07T08:00:00Z', lastAttemptAt: null, lastError: null, stale: false,
    models: listes.map((model) => ({ model, displayName: null, available: true, supportsGeneration: true, supportsThinking: null, inputTokenLimit: null, outputTokenLimit: null, lastSeenAt: '2026-10-07T08:00:00Z' })),
  }),
}));
vi.mock('@/services/ai/provider/model-operational.service', () => ({
  loadOperationalStatuses: async () => new Map([['gemini-3.6-flash', { ok: false, checkedAt: '2026-10-07T08:00:00Z', error: '404', source: 'catalog_refresh' }]]),
}));
vi.mock('@/services/ai/gateway/pricing/pricing.repository', () => ({
  getCacheState: () => ({ loadedAt: new Date(), size: 1, degraded: false, lastError: null }),
  loadPricingCache: async () => undefined,
  getCachedPrice: () => ({ verified: false }),
}));
vi.mock('@/services/verebona-assistant/config/assistant-settings', () => ({
  refreshAssistantSettings: async () => undefined, effectiveSetting: () => false,
}));
const appelFournisseur = vi.fn();
vi.mock('@/services/ai/gateway/providers', () => ({ getAiProvider: () => ({ call: appelFournisseur }) }));

const { GET } = await import('../route');

beforeEach(() => { appelFournisseur.mockReset(); });

describe('MOD — API du catalogue', () => {
  it('MOD-35 — modelsByTreatment par traitement (T1…T6), motifs des exclus, liste globale conservée ; AUCUN appel fournisseur', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await GET(new NextRequest('http://localhost/api/admin/ai/config-catalogs'));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      models: unknown[];
      modelsByTreatment: Record<string, Array<{ model: string; priced: boolean; verified: boolean }>>;
      excludedByTreatment: Record<string, Array<{ model: string; reasonText: string }>>;
    };
    expect(Object.keys(body.modelsByTreatment)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
    expect(body.modelsByTreatment.T2.map((m) => m.model)).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
    expect(body.modelsByTreatment.T2[0]).toMatchObject({ priced: true, verified: false });
    // Déprécié, preview non autorisé (T2), non opérationnel : absents, motif nommé.
    const exclus = Object.fromEntries(body.excludedByTreatment.T2.map((x) => [x.model, x.reasonText]));
    expect(exclus['gemini-2.5-pro']).toBe('déprécié');
    expect(exclus['gemini-3.1-pro-preview']).toBe('preview non autorisé');
    expect(exclus['gemini-3.6-flash']).toBe('non opérationnel avec la clé active');
    // T5 (PO 26) : même source, mêmes règles.
    expect(body.modelsByTreatment.T5.map((m) => m.model)).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview']);
    expect(Array.isArray(body.models)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(appelFournisseur).not.toHaveBeenCalled();
  });
});
