/**
 * Lot 32B sur PostgreSQL réel — modèles réellement utilisables par
 * traitement (migration 0273) et chaîne de secours T5 au BO (PO 26) :
 *   · `GET /api/admin/ai/config-catalogs` lit catalogue fournisseur, tarifs
 *     et état opérationnel (empreinte de la clé active) — aucun appel
 *     fournisseur — et rend `modelsByTreatment` ;
 *   · `PUT …/entries/T2` : un modèle non utilisable choisi par l'API est
 *     refusé (409 MODEL_NOT_USABLE), rien n'est écrit ;
 *   · T5 : principal / repli 1 / repli 2 enregistrés dans un brouillon,
 *     depuis la même liste.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ adminId: 0, email: 'admin-l32b@e2e.test' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => session.adminId,
    getSession: async () => ({ userId: session.adminId, email: session.email, role: 'ADMIN' }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

const LISTES = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-pro'];

scenario('L32B', 'Modèles utilisables par traitement, état opérationnel, chaîne T5 au BO', ({ sql, make }) => {
  let versionId = 0;

  beforeAll(async () => {
    const admin = await make.user({ role: 'ADMIN' });
    session.adminId = admin.id;
    const { setProviderSecretResolver } = await import('@/services/ai/provider/provider-secret');
    setProviderSecretResolver(async () => 'cle-e2e-l32b');
    const { keyFingerprint } = await import('@/services/ai/provider/model-operational.service');
    await sql`DELETE FROM ai_model_catalog WHERE provider = 'gemini'`;
    await sql`DELETE FROM ai_model_catalog_refresh WHERE provider = 'gemini'`;
    for (const m of LISTES) {
      await sql`INSERT INTO ai_model_catalog (provider, model, available, supports_generation) VALUES ('gemini', ${m}, TRUE, TRUE)`;
    }
    await sql`INSERT INTO ai_model_catalog_refresh (provider, refreshed_at, attempted_at, ok, models_seen) VALUES ('gemini', now(), now(), TRUE, ${LISTES.length})`;
    await sql`DELETE FROM ai_model_operational_status`;
    await sql`INSERT INTO ai_model_operational_status (provider, model, key_fingerprint, ok, error, source)
              VALUES ('gemini', 'gemini-3.5-flash', ${keyFingerprint('cle-e2e-l32b')}, FALSE, '404 no longer available', 'catalog_refresh'),
                     ('gemini', 'gemini-3.6-flash', ${keyFingerprint('ancienne-cle')}, FALSE, '404', 'provider_test')`;
    const { primePricingCache } = await import('@/services/ai/gateway/pricing/pricing.repository');
    primePricingCache(LISTES.map((model) => ({
      provider: 'gemini', model, inputMicros: 1, outputMicros: 1, currency: 'USD', source: 'public_catalog', verified: false, fetchedAt: new Date(),
    }) as never));
    const { createDraft } = await import('@/services/ai/config/config-version.repository');
    versionId = (await createDraft(admin.id, 'e2e-l32b')).id;
  });

  afterAll(async () => {
    await sql`DELETE FROM ai_config_entries WHERE version_id = ${versionId}`.catch(() => undefined);
    await sql`DELETE FROM ai_config_versions WHERE id = ${versionId}`.catch(() => undefined);
    await sql`DELETE FROM ai_model_operational_status`;
    await sql`DELETE FROM ai_model_catalog WHERE provider = 'gemini'`;
    await sql`DELETE FROM ai_model_catalog_refresh WHERE provider = 'gemini'`;
    const { setProviderSecretResolver } = await import('@/services/ai/provider/provider-secret');
    setProviderSecretResolver(null);
    const { clearPricingCache } = await import('@/services/ai/gateway/pricing/pricing.repository');
    clearPricingCache();
  });

  async function catalogue() {
    const { GET } = await import('@/app/api/admin/ai/config-catalogs/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://app.test/api/admin/ai/config-catalogs'));
    return { status: res.status, body: await res.json() as Record<string, any> };
  }

  async function put(t: string, body: Record<string, unknown>) {
    const { PUT } = await import('@/app/api/admin/ai/config-versions/[id]/entries/[treatment]/route');
    const { NextRequest } = await import('next/server');
    const res = await PUT(new NextRequest(`http://app.test/api/admin/ai/config-versions/${versionId}/entries/${t}`, {
      method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    }), { params: Promise.resolve({ id: String(versionId), treatment: t }) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  }

  it('MOD-36 — modelsByTreatment sur base réelle : catalogue rafraîchi, état opérationnel de la CLÉ ACTIVE seulement, aucun appel fournisseur', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await catalogue();
    expect(r.status).toBe(200);
    const t2 = (r.body.modelsByTreatment.T2 as Array<{ model: string }>).map((m) => m.model);
    // 3.5-flash : non opérationnel avec la clé active → absent ; 3.6-flash :
    // échec obtenu avec une AUTRE clé → ignoré, proposé ; 2.5-pro : déprécié.
    expect(t2).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash']);
    const exclusT2 = Object.fromEntries((r.body.excludedByTreatment.T2 as Array<{ model: string; reasonText: string }>).map((x) => [x.model, x.reasonText]));
    expect(exclusT2['gemini-3.5-flash']).toBe('non opérationnel avec la clé active');
    expect(exclusT2['gemini-2.5-pro']).toBe('déprécié');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('MOD-37 — PUT d’une entrée T2 avec un modèle non utilisable : 409 MODEL_NOT_USABLE, rien d’écrit', async () => {
    const r = await put('T2', { primaryModel: 'gemini-3.5-flash-lite', fallback1: 'gemini-2.5-pro', reasoningPrimary: 'standard', maxOutputTokens: 400 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'MODEL_NOT_USABLE' });
    const [e] = await sql<{ fallback_1: string | null }[]>`SELECT fallback_1 FROM ai_config_entries WHERE version_id = ${versionId} AND treatment = 'T2'`;
    expect(e?.fallback_1 ?? null).not.toBe('gemini-2.5-pro');
  });

  it('PO26-03 — T5 : principal, repli 1 et repli 2 enregistrés au BO depuis la même liste utilisable', async () => {
    const r = await catalogue();
    const t5 = (r.body.modelsByTreatment.T5 as Array<{ model: string }>).map((m) => m.model);
    expect(t5).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash']);
    const ok = await put('T5', {
      primaryModel: 'gemini-3.6-flash', fallback1: 'gemini-3.1-flash-lite', fallback2: 'gemini-3.5-flash-lite',
      reasoningPrimary: 'standard', reasoningFallback1: 'standard', reasoningFallback2: 'standard', maxOutputTokens: 8000,
    });
    expect(ok.status).toBe(200);
    const { getVersion } = await import('@/services/ai/config/config-version.repository');
    const t5Entry = (await getVersion(versionId))!.entries.find((e) => e.treatment === 'T5')!;
    expect([t5Entry.primaryModel, t5Entry.fallback1, t5Entry.fallback2]).toEqual(['gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']);
  });
});
