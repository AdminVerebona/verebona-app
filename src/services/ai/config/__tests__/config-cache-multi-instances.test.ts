/**
 * CFG-01 (CDC 15) — invalidation de la configuration IA entre instances.
 *
 * Deux « instances » = deux copies indépendantes des modules (vi.resetModules),
 * chacune avec son propre cache en mémoire, qui partagent :
 *   · une « base » simulée (version effective, lue par le dépôt mocké) ;
 *   · le compteur `verebona_cache_versions` (périmètre `ai-config`).
 *
 * Recette : après une promotion faite sur l'instance A, un nouvel appel sur
 * l'instance B utilise IMMÉDIATEMENT le nouveau `configVersionId` — sans
 * attendre l'expiration du cache de 30 s.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emptyTreatmentConfig, type TreatmentConfig } from '../config-types';
import type { ConfigVersionCounterStore } from '../config-cache-version';

const partage = vi.hoisted(() => ({
  effective: null as null | { id: number; visibleNumber: number | null; entries: TreatmentConfig[] },
  lectures: 0,
  counter: 0,
  counterUnreadable: false,
}));

vi.mock('../config-version.repository', () => {
  const lire = async () => {
    partage.lectures += 1;
    return partage.effective;
  };
  return {
    getEffectiveVersion: lire,
    // Lot 54 : le résolveur lit version active + révision en une requête.
    getRuntimeConfiguration: async () => {
      const v = (await lire()) as { id: number; visibleNumber?: number | null; entries: unknown[] } | null;
      return v ? { versionId: v.id, visibleNumber: v.visibleNumber ?? null, revisionId: null, revisionNumber: null, entries: v.entries, masterPrompts: {} } : null;
    },
  };
});

const store: ConfigVersionCounterStore = {
  async read() {
    if (partage.counterUnreadable) throw new Error('base indisponible');
    return partage.counter;
  },
  async bump() {
    partage.counter += 1;
  },
};

type Instance = {
  resolver: typeof import('../config-resolver');
  counter: typeof import('../config-cache-version');
  execCtx: typeof import('../../telemetry/execution-context');
};

async function demarrerInstance(): Promise<Instance> {
  vi.resetModules();
  const counter = await import('../config-cache-version');
  counter.__setConfigVersionCounterStoreForTests(store);
  const resolver = await import('../config-resolver');
  const execCtx = await import('../../telemetry/execution-context');
  return { resolver, counter, execCtx };
}

const version = (id: number, primaryModel: string) => ({
  id, visibleNumber: id, entries: [{ ...emptyTreatmentConfig('T1'), primaryModel, prompt: 'cadre' }],
});

// Horloge simulée (Date.now seulement) : la mémoire du compteur dure ~1 s.
// Horloge FIGÉE, avancée seulement par `avancer` : sur un poste chargé
// (suite complète sous Windows), plus d'une seconde réelle pouvait s'écouler
// entre deux appels et expirer la mémoire à l'insu du test.
let decalage = 0;
const origine = Date.now();
function avancer(ms: number) { decalage += ms + 1; }
vi.spyOn(Date, 'now').mockImplementation(() => origine + decalage);

beforeEach(() => {
  vi.spyOn(Date, 'now').mockImplementation(() => origine + decalage);
  partage.effective = version(1, 'gemini-2.5-flash');
  partage.lectures = 0;
  partage.counter = 0;
  partage.counterUnreadable = false;
});

describe('CFG-01 : clé de version partagée', () => {
  it('une bascule signalée par A est prise IMMÉDIATEMENT par B (id et modèle)', async () => {
    const a = await demarrerInstance();
    const b = await demarrerInstance();

    // Les deux instances chargent et mettent en cache la version 1.
    expect((await a.resolver.resolveOperationConfig('t1_analyze_document')).configVersionId).toBe(1);
    expect((await b.resolver.resolveOperationConfig('t1_analyze_document')).configVersionId).toBe(1);
    const lecturesAvant = partage.lectures;

    // Sans bascule : B sert son cache, aucune relecture de la version.
    await b.resolver.resolveOperationConfig('t1_analyze_document');
    expect(partage.lectures).toBe(lecturesAvant);

    // Promotion sur A : la base change, A incrémente la clé partagée.
    partage.effective = version(2, 'gemini-2.5-pro');
    await a.counter.bumpConfigVersionCounter('promote:2');
    // A la voit immédiatement (sa mémoire du compteur est vidée).
    expect((await a.resolver.resolveOperationConfig('t1_analyze_document')).configVersionId).toBe(2);
    // B : dans la seconde de mémoire du compteur, encore l'ancienne…
    expect((await b.resolver.resolveOperationConfig('t1_analyze_document')).configVersionId).toBe(1);
    // … puis la nouvelle dès l'expiration (≤ 1 s, contre 30 s de cache avant).
    avancer(b.counter.COUNTER_MEMO_MS);

    const surB = await b.resolver.resolveOperationConfig('t1_analyze_document');
    expect(surB.configVersionId).toBe(2);
    expect(surB.primaryModel).toBe('gemini-2.5-pro');
    expect(await b.resolver.resolveEffectiveVersionId()).toBe(2);
  });

  it('la version tracée (contexte d’exécution) suit aussi la clé partagée', async () => {
    const a = await demarrerInstance();
    const b = await demarrerInstance();
    expect((await b.execCtx.getExecutionContext()).configVersionId).toBe(1);

    partage.effective = version(3, 'gemini-2.5-flash');
    await a.counter.bumpConfigVersionCounter('rollback:3');
    avancer(b.counter.COUNTER_MEMO_MS);
    expect((await b.execCtx.getExecutionContext()).configVersionId).toBe(3);
  });

  it('clé illisible : repli sur le cache (TTL), jamais d’échec', async () => {
    const b = await demarrerInstance();
    expect((await b.resolver.resolveOperationConfig('t1_analyze_document')).configVersionId).toBe(1);
    partage.counterUnreadable = true;
    partage.effective = version(4, 'gemini-2.5-flash');
    // Dans le TTL, l'ancienne version reste servie : dégradé, pas cassé.
    expect((await b.resolver.resolveOperationConfig('t1_analyze_document')).configVersionId).toBe(1);
    // La clé redevient lisible (et a bougé entre-temps) : rechargement.
    partage.counterUnreadable = false;
    partage.counter += 1;
    avancer(b.counter.COUNTER_MEMO_MS);
    expect((await b.resolver.resolveOperationConfig('t1_analyze_document')).configVersionId).toBe(4);
  });
});

describe('CFG-01 : coût de la clé partagée', () => {
  it('lecture mémorisée ~1 s et regroupée : une lecture pour une rafale d’appels', async () => {
    const b = await demarrerInstance();
    const read = vi.spyOn(store, 'read');
    await Promise.all(Array.from({ length: 10 }, () => b.resolver.resolveOperationConfig('t1_analyze_document')));
    await b.resolver.resolveOperationConfig('t1_analyze_document');
    expect(read).toHaveBeenCalledTimes(1);
    avancer(b.counter.COUNTER_MEMO_MS);
    await b.resolver.resolveOperationConfig('t1_analyze_document');
    expect(read).toHaveBeenCalledTimes(2);
    read.mockRestore();
  });
});

describe('CFG-01 : le service de versions invalide les caches après chaque écriture (lot 54)', () => {
  it('activation, réactivation, enregistrement, restauration : caches locaux vidés ; clé partagée incrémentée (stockage de test)', async () => {
    vi.resetModules();
    const bump = vi.fn(async () => true);
    const vidage = vi.fn();
    vi.doMock('../config-cache-version', () => ({
      bumpConfigVersionCounter: bump, forgetConfigVersionCounter: () => {}, hasTestCounterStore: () => true,
    }));
    vi.doMock('../config-resolver', () => ({ invalidateConfigCache: () => vidage() }));
    vi.doMock('../../telemetry/execution-context', () => ({ invalidateConfigVersionCache: () => {} }));
    vi.doMock('@/services/verebona-assistant/core/model-startup-check', () => ({ runAssistantStartupCheck: async () => null }));
    vi.doMock('../config-entry.audit', () => ({ recordConfigAudit: async () => {} }));
    const valide = { id: 9, status: 'INACTIVE', environment: 'local', label: 'v', activatedAt: new Date(), visibleNumber: 3, entries: [], deletedAt: null, currentRevisionNumber: 1 };
    const ecrit = { versionId: 9, revisionId: 2, revisionNumber: 2, changed: true, active: true, masterPromptSwitches: [] };
    vi.doMock('../config-version.repository', () => ({
      getVersion: async () => valide,
      getActiveVersion: async () => null,
      activateVersion: async () => ({ previousId: null, alreadyActive: false, revisionNumber: 1, masterPromptSwitches: [] }),
      writeSnapshot: async () => ecrit,
      getRevision: async () => ({ id: 5, versionId: 9, revisionNumber: 1, snapshot: { format: 'ai-config-snapshot-v1', entries: [], masterPrompts: {} } }),
      getMasterPromptVersionRef: async () => null,
      ConfigVersionRefused: class extends Error {},
    }));
    vi.doMock('../config-validation.service', () => ({ validateVersion: () => ({ valid: true, issues: [] }) }));
    vi.doMock('../../gateway/pricing/gemini-public-catalog', () => ({ GEMINI_PUBLIC_CATALOG: [] }));
    vi.doMock('../../gateway/pricing/pricing.repository', () => ({
      getCachedPrice: () => null, loadPricingCache: async () => undefined, getCacheState: () => ({ loadedAt: new Date() }),
    }));
    vi.doMock('../../provider/model-catalog.service', () => ({
      getCatalogState: async () => ({ refreshedAt: null, models: [] }), selectableModels: () => [],
    }));

    const svc = await import('../config-version.service');
    await svc.activate(9, 1);
    await svc.rollback(9, 1);
    await svc.saveConfiguration(9, { expectedRevision: 1, entries: [emptyTreatmentConfig('T1')] }, 1);
    await svc.restoreRevision(9, 5, 1);
    expect(bump.mock.calls.map((c) => String((c as unknown[])[0]).split(':')[0])).toEqual(
      ['activate', 'activate', 'save', 'restore'],
    );
    expect(vidage).toHaveBeenCalledTimes(4);
    vi.doUnmock('../config-cache-version');
  });
});
