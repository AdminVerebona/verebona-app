/**
 * APP-PERF-12 — droits partagés dans un EntitlementsProvider.
 *
 * Recette : T-01 (layout, WriteGuard et panneau « Ajouter » montés ensemble :
 * une lecture), T-02 (PWA réveillée, cookie d'accès expiré, renouvellement
 * valide : droits corrects sans blocage durable), T-03 (offre/quota modifiés,
 * changement de compte : aucun droit de l'ancien compte réutilisé).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient, ApiClientError, __resetApiClientForTests } from '@/lib/api-client';
import { EntitlementsStore, type EntitlementsState } from '@/lib/entitlements/entitlements-store';

const droits = (plan: string, over: Partial<EntitlementsState> = {}): EntitlementsState => ({
  plan, status: 'active', canWrite: true, isRestricted: false, premiumFeatures: plan === 'premium',
  quotas: {
    assets: { used: 1, limit: 5, ratio: 0.2, label: '1 sur 5', shouldWarn: false, isFull: false },
    documents: { used: 1, limit: 50, ratio: 0.02, label: '1 sur 50', shouldWarn: false, isFull: false },
    users: { limit: 1 },
  },
  trial: { status: 'none', daysRemaining: 0, endsAt: null, isUrgent: false, dejaConsomme: false },
  unpaid: null,
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { __resetApiClientForTests(); });
afterEach(() => { vi.unstubAllGlobals(); __resetApiClientForTests(); });

describe('CA-01 — une lecture, un état pour tous', () => {
  it('T-01 : trois consommateurs déclenchent ensemble → une seule lecture', async () => {
    const fetchEntitlements = vi.fn(async () => droits('standard'));
    const store = new EntitlementsStore({ fetchEntitlements });
    await Promise.all([store.refreshIfStale(), store.refreshIfStale(), store.refresh()]);
    expect(fetchEntitlements).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ status: 'known', isLoading: false, data: { plan: 'standard' } });
    // Frais : un nouveau montage ne relit pas.
    await store.refreshIfStale();
    expect(fetchEntitlements).toHaveBeenCalledTimes(1);
  });

  it('relecture une fois la durée de validité écoulée', async () => {
    let t = 0;
    const fetchEntitlements = vi.fn(async () => droits('standard'));
    const store = new EntitlementsStore({ fetchEntitlements, now: () => t });
    await store.refreshIfStale(60_000);
    t = 61_000;
    await store.refreshIfStale(60_000);
    expect(fetchEntitlements).toHaveBeenCalledTimes(2);
  });
});

describe('CA-02 — actualisés après offre, quota et changement de compte', () => {
  it('écriture réussie (quota) : droits marqués périmés puis relus', async () => {
    const fetchEntitlements = vi.fn()
      .mockResolvedValueOnce(droits('standard'))
      .mockResolvedValueOnce(droits('standard', { quotas: { ...droits('standard').quotas, assets: { used: 5, limit: 5, ratio: 1, label: '5 sur 5', shouldWarn: true, isFull: true } } }));
    const store = new EntitlementsStore({ fetchEntitlements });
    await store.refresh();
    store.markStale();
    await store.refreshIfStale();
    expect(store.getSnapshot().data?.quotas.assets.isFull).toBe(true);
  });

  it('T-03 : changement de compte pendant une lecture → réponse tardive ignorée, droits vidés', async () => {
    let relacher: (d: EntitlementsState) => void = () => undefined;
    const fetchEntitlements = vi.fn()
      .mockResolvedValueOnce(droits('premium'))
      .mockImplementationOnce(() => new Promise<EntitlementsState>((r) => { relacher = r; }))
      .mockResolvedValueOnce(droits('standard'));
    const store = new EntitlementsStore({ fetchEntitlements });
    await store.refresh();
    expect(store.getSnapshot().data?.plan).toBe('premium');
    const enCours = store.refresh();
    store.reset();
    expect(store.getSnapshot()).toMatchObject({ data: null, status: 'unknown' });
    relacher(droits('premium'));
    await enCours;
    expect(store.getSnapshot().data).toBeNull();
    await store.refresh();
    expect(store.getSnapshot().data?.plan).toBe('standard');
  });

  it('sortie de session : droits vidés, rien à attendre', () => {
    const store = new EntitlementsStore({ fetchEntitlements: vi.fn() });
    store.reset({ idle: true });
    expect(store.getSnapshot()).toEqual({ data: null, status: 'unknown', isLoading: false });
  });
});

describe('CA-03 — erreurs temporaires : ni droits accordés, ni fenêtre injustifiée', () => {
  it('panne temporaire : dernière valeur conservée, état « unavailable », relecture au prochain déclencheur', async () => {
    const fetchEntitlements = vi.fn()
      .mockResolvedValueOnce(droits('standard', { isRestricted: true, canWrite: false }))
      .mockRejectedValueOnce(new ApiClientError(503, 'SERVICE_UNAVAILABLE'));
    let t = 0;
    const store = new EntitlementsStore({ fetchEntitlements, now: () => t });
    await store.refresh();
    t = 61_000;
    await store.refreshIfStale();
    // Toujours restreint : une panne ne lève pas une restriction.
    expect(store.getSnapshot()).toMatchObject({ status: 'unavailable', data: { isRestricted: true } });
    expect(store.isStale()).toBe(true);
  });

  it('refus de session définitif : droits inconnus (pas « refusés »)', async () => {
    const store = new EntitlementsStore({ fetchEntitlements: async () => { throw new ApiClientError(401, 'UNAUTHORIZED'); } });
    await store.refresh();
    expect(store.getSnapshot()).toEqual({ data: null, status: 'unknown', isLoading: false });
  });

  it('T-02 : PWA réveillée, cookie d’accès expiré, renouvellement valide → droits corrects', async () => {
    let renouvele = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/auth/refresh') { renouvele = true; return json({}); }
      return renouvele ? json(droits('premium')) : json({ code: 'INVALID_TOKEN' }, 401);
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = new EntitlementsStore({
      fetchEntitlements: (signal) => apiClient.get<EntitlementsState>('/api/billing/trial-status', { signal, dedupe: true, onAuthFailure: 'silent' }),
    });
    await store.refresh();
    await flush();
    expect(store.getSnapshot()).toMatchObject({ status: 'known', data: { plan: 'premium' } });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/billing/trial-status', '/api/auth/refresh', '/api/billing/trial-status']);
  });
});

describe('câblage', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  it('plus de fetch direct de trial-status dans le hook ; un fournisseur dans ClientShell', () => {
    const hook = read('src/hooks/useEntitlements.ts');
    expect(hook).not.toMatch(/fetch\('\/api\/billing\/trial-status'/);
    expect(hook).toMatch(/apiClient\.get<EntitlementsState>\('\/api\/billing\/trial-status'/);
    expect(hook).not.toMatch(/useRef\(/);
    const shell = read('src/components/ClientShell.tsx');
    expect(shell).toMatch(/<SessionProvider>\s*<EntitlementsProvider>\s*<WriteGuardProvider>/);
  });
});
