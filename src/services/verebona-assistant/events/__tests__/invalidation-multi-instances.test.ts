/**
 * Invalidation du cache de l'assistant sur TOUTES les instances — CDC §31.7,
 * CA-26, §25.7 (régression P1 de l'audit).
 *
 * Deux instances sont simulées par deux graphes de modules distincts
 * (`vi.resetModules`) : chacune a son propre cache en mémoire et son propre
 * bus d'événements, et elles partagent la même « base » (table
 * `verebona_cache_versions` simulée).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const base = vi.hoisted(() => ({
  versions: new Map<string, number>(),
  enPanne: false,
}));

vi.mock('@/db', () => {
  const unsafe = vi.fn(async (sql: string, p: unknown[] = []) => {
    if (base.enPanne) throw new Error('base indisponible');
    if (/SELECT scope, version FROM verebona_cache_versions/.test(sql)) {
      const scopes = p[0] as string[];
      return scopes.filter((s) => base.versions.has(s)).map((s) => ({ scope: s, version: String(base.versions.get(s)) }));
    }
    if (/INSERT INTO verebona_cache_versions/.test(sql)) {
      const scope = String(p[0]);
      base.versions.set(scope, (base.versions.get(scope) ?? 0) + 1);
      return [];
    }
    return [];
  });
  return { pgClient: Object.assign(unsafe, { unsafe }), db: {}, ensureMigrations: vi.fn(async () => {}) };
});

type Cache = typeof import('../../core/retrieval-cache');
type Bus = typeof import('../business-events');
type Handlers = typeof import('../handlers');
interface Instance { cache: Cache; bus: Bus; handlers: Handlers }

/** Une « instance » : un graphe de modules neuf (cache, bus, abonnés propres). */
async function demarrerInstance(): Promise<Instance> {
  vi.resetModules();
  const cache = await import('../../core/retrieval-cache');
  const bus = await import('../business-events');
  const handlers = await import('../handlers');
  handlers.registerAssistantBusinessEventHandlers();
  return { cache, bus, handlers };
}

const INPUT = { accountId: 7, userId: 3, planType: 'PREMIUM', message: 'résume mon compte', clientRequestId: 'c', locale: 'fr-FR' };

async function route() {
  const { routeForIntent } = await import('../../core/intent-router.service');
  return routeForIntent('ACCOUNT_SUMMARY', 'PREMIUM', 't');
}

beforeEach(() => {
  base.versions.clear();
  base.enPanne = false;
});

describe('§31.7, CA-26 — deux instances, une seule vérité', () => {
  it('une modification reçue par l’instance B invalide le cache de l’instance A', async () => {
    const a = await demarrerInstance();
    const b = await demarrerInstance();
    const r = await route();
    const avant = vi.fn(async () => [{ id: 'asset_1', type: 'asset_field' as const, title: 'Maison', content: 'ancienne valeur' }]);
    const apres = vi.fn(async () => [{ id: 'asset_1', type: 'asset_field' as const, title: 'Maison', content: 'nouvelle valeur' }]);

    // A calcule et met en cache.
    expect((await a.cache.cachedRetrieve(r, INPUT, avant, 60)).hit).toBe(false);
    expect((await a.cache.cachedRetrieve(r, INPUT, avant, 60)).hit).toBe(true);

    // La modification arrive sur B (PUT /api/assets traité par B).
    await b.bus.emitBusinessEvent({ type: 'ASSET_UPDATED', accountId: 7, entityId: 1 });
    expect(base.versions.get('account:7')).toBe(1);
    // Instances réellement distinctes : l'entrée de A est toujours en mémoire,
    // seule la version partagée peut l'écarter.
    expect(a.cache).not.toBe(b.cache);
    expect(a.cache.retrievalCacheSize()).toBe(1);

    // A ne ressert plus l'ancienne valeur : nouvelle clé, nouveau calcul.
    const r2 = await a.cache.cachedRetrieve(r, INPUT, apres, 60);
    expect(r2.hit).toBe(false);
    expect(r2.sources[0].content).toBe('nouvelle valeur');
  });

  it('l’invalidation d’un compte ne touche pas le cache d’un autre compte', async () => {
    const a = await demarrerInstance();
    const b = await demarrerInstance();
    const r = await route();
    const f = vi.fn(async () => []);
    await a.cache.cachedRetrieve(r, { ...INPUT, accountId: 8 }, f, 60);
    await b.bus.emitBusinessEvent({ type: 'DOCUMENT_UPLOADED', accountId: 7, entityId: 12 });
    expect((await a.cache.cachedRetrieve(r, { ...INPUT, accountId: 8 }, f, 60)).hit).toBe(true);
  });

  it('événement global (article d’aide publié) : tous les comptes, toutes les instances', async () => {
    const a = await demarrerInstance();
    const b = await demarrerInstance();
    const r = await route();
    const f = vi.fn(async () => []);
    await a.cache.cachedRetrieve(r, INPUT, f, 60);
    await a.cache.cachedRetrieve(r, { ...INPUT, accountId: 8 }, f, 60);
    await b.bus.emitBusinessEvent({ type: 'HELP_ENTRY_PUBLISHED', accountId: null });
    expect(base.versions.get('global')).toBe(1);
    expect((await a.cache.cachedRetrieve(r, INPUT, f, 60)).hit).toBe(false);
    expect((await a.cache.cachedRetrieve(r, { ...INPUT, accountId: 8 }, f, 60)).hit).toBe(false);
  });

  it('signaux hors catalogue (fournisseur, effacement de la conversation) : même invalidation', async () => {
    const a = await demarrerInstance();
    const b = await demarrerInstance();
    const r = await route();
    const f = vi.fn(async () => []);
    for (const type of ['SUPPLIER_CHANGED', 'CONVERSATION_CLEARED'] as const) {
      await a.cache.cachedRetrieve(r, INPUT, f, 60);
      expect((await a.cache.cachedRetrieve(r, INPUT, f, 60)).hit).toBe(true);
      await b.bus.emitBusinessEvent({ type, accountId: 7 });
      expect((await a.cache.cachedRetrieve(r, INPUT, f, 60)).hit).toBe(false);
    }
    // Le catalogue fermé du §25.7 reste de 14 événements.
    expect(b.bus.ASSISTANT_BUSINESS_EVENTS).toHaveLength(14);
    expect(b.bus.isAssistantBusinessEvent('SUPPLIER_CHANGED')).toBe(false);
    expect(b.bus.businessEventCounters().SUPPLIER_CHANGED).toBe(1);
  });

  it('versions illisibles : le cache est contourné (jamais une entrée de fraîcheur non prouvée)', async () => {
    const a = await demarrerInstance();
    const r = await route();
    const f = vi.fn(async () => []);
    await a.cache.cachedRetrieve(r, INPUT, f, 60);
    base.enPanne = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await a.cache.cachedRetrieve(r, INPUT, f, 60)).hit).toBe(false);
    expect(f).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('la locale fait partie de la clé', async () => {
    const a = await demarrerInstance();
    const r = await route();
    expect(a.cache.retrievalCacheKey(r, INPUT)).not.toBe(a.cache.retrievalCacheKey(r, { ...INPUT, locale: 'en-GB' }));
  });
});

describe('§31.7 — chaque chemin de modification émet son événement', () => {
  const API = join(process.cwd(), 'src/app/api');
  const lire = (p: string) => readFileSync(join(API, p), 'utf8');
  const emet = (src: string, type: string) => new RegExp(`await emitBusinessEvent\\(\\{ type: '${type}'`).test(src)
    || new RegExp(`await emitBusinessEvents\\([^;]*type: '${type}'`).test(src);

  it.each([
    ['assets/route.ts', ['ASSET_CREATED', 'ASSET_UPDATED', 'ASSET_DELETED']],
    ['assets/[id]/details/[section]/route.ts', ['ASSET_UPDATED']],
    ['assets/[id]/equipments/route.ts', ['ASSET_UPDATED']],
    ['assets/[id]/equipments/[equipId]/route.ts', ['ASSET_UPDATED']],
    ['assets/[id]/substructures/route.ts', ['ASSET_UPDATED']],
    ['assets/[id]/substructures/[subId]/route.ts', ['ASSET_UPDATED']],
    ['assets/[id]/substructures/order/route.ts', ['ASSET_UPDATED']],
    ['assets/[id]/valuations/route.ts', ['ASSET_UPDATED']],
    ['files/confirm/route.ts', ['DOCUMENT_UPLOADED']],
    ['files/[id]/route.ts', ['DOCUMENT_DELETED']],
    ['documents/[id]/route.ts', ['DOCUMENT_UPDATED']],
    ['documents/[id]/commit/route.ts', ['DOCUMENT_UPDATED']],
    ['documents/[id]/supplier/route.ts', ['DOCUMENT_UPDATED']],
    ['documents/[id]/fusion/route.ts', ['DOCUMENT_DELETED']],
    ['documents/bulk-delete/route.ts', ['DOCUMENT_DELETED']],
    ['documents/bulk-move/route.ts', ['DOCUMENT_UPDATED']],
    ['v2/documents/[publicId]/classification/route.ts', ['DOCUMENT_UPDATED']],
    ['suppliers/route.ts', ['SUPPLIER_CHANGED']],
    ['suppliers/[id]/route.ts', ['SUPPLIER_CHANGED']],
    ['suppliers/[id]/archive/route.ts', ['SUPPLIER_CHANGED']],
    ['agenda/route.ts', ['AGENDA_ITEM_CREATED']],
    ['agenda/[id]/route.ts', ['AGENDA_ITEM_UPDATED', 'AGENDA_ITEM_DELETED']],
    ['agenda/[id]/confirm/route.ts', ['AGENDA_ITEM_UPDATED']],
    ['agenda/[id]/statut/route.ts', ['AGENDA_ITEM_UPDATED']],
    ['v2/to-process/[publicId]/resolve/route.ts', ['TO_PROCESS_ITEM_UPDATED']],
    ['to-process/conficts/[id]/resolve/route.ts', ['TO_PROCESS_ITEM_UPDATED']],
    ['to-process/suppliers/[id]/resolve/route.ts', ['TO_PROCESS_ITEM_UPDATED']],
    ['to-process/suppliers/bulk-resolve/route.ts', ['TO_PROCESS_ITEM_UPDATED']],
    ['verebona/conversation/route.ts', ['CONVERSATION_CLEARED']],
  ] as const)('%s émet %j (attendu avant la réponse)', (fichier, types) => {
    const src = lire(fichier);
    for (const t of types) expect(emet(src, t), `${fichier} : ${t}`).toBe(true);
    // Plus d'émission « lancée sans attendre » : la réponse part après l'invalidation.
    expect(/void emitBusinessEvents?\(/.test(src)).toBe(false);
    // Jamais une émission par élément dans une boucle (une invalidation par demande).
    expect(/for \([^)]*\)\s*(?:\{\s*)?await emitBusinessEvent\(/.test(src)).toBe(false);
  });
});

describe('§31.7 — une invalidation par demande et par compte (opérations en lot)', () => {
  it('50 documents supprimés : 50 événements comptés, UN incrément de version par compte', async () => {
    const inst = await demarrerInstance();
    const lot = Array.from({ length: 50 }, (_, i) => ({ type: 'DOCUMENT_DELETED' as const, accountId: 7, entityId: i + 1 }));
    await inst.bus.emitBusinessEvents([...lot, { type: 'DOCUMENT_UPDATED', accountId: 8, entityId: 99 }]);
    expect(inst.bus.businessEventCounters().DOCUMENT_DELETED).toBe(50);
    expect(base.versions.get('account:7')).toBe(1);
    expect(base.versions.get('account:8')).toBe(1);
    await inst.handlers.flushModelCachePurgesForTests();
  });

  it('lot mixte : la suppression l’emporte (purge des réponses modèle déclenchée une fois)', async () => {
    const inst = await demarrerInstance();
    const vus: Array<[string, unknown]> = [];
    inst.bus.onBusinessEvent('espion', (e) => { vus.push([e.type, e.entityId]); });
    await inst.bus.emitBusinessEvents([
      { type: 'DOCUMENT_UPDATED', accountId: 7, entityId: 1 },
      { type: 'DOCUMENT_DELETED', accountId: 7, entityId: 2 },
      { type: 'DOCUMENT_UPDATED', accountId: 7, entityId: 3 },
    ]);
    expect(vus).toEqual([['DOCUMENT_DELETED', null]]);
  });

  it('lot vide : rien ; lot d’un seul élément : événement inchangé', async () => {
    const inst = await demarrerInstance();
    const vus: unknown[] = [];
    inst.bus.onBusinessEvent('espion', (e) => { vus.push(e.entityId); });
    await inst.bus.emitBusinessEvents([]);
    await inst.bus.emitBusinessEvents([{ type: 'DOCUMENT_UPLOADED', accountId: 7, entityId: 42 }]);
    expect(vus).toEqual([42]);
    expect(base.versions.get('account:7')).toBe(1);
  });
});

describe('§25.7 — HELP_ENTRY_PUBLISHED : nouvelle version du corpus d’aide constatée', () => {
  it('première lecture : référence seulement ; version différente : événement global ; même version : rien', async () => {
    const inst = await demarrerInstance();
    const aide = await import('../../core/help-corpus.service');
    aide.resetHelpCorpusCacheForTests();
    expect(await aide.noteHelpCorpusVersion('2026-09-01')).toBe(false);
    expect(await aide.noteHelpCorpusVersion('2026-09-01')).toBe(false);
    expect(base.versions.get('global')).toBeUndefined();
    expect(await aide.noteHelpCorpusVersion('2026-09-28')).toBe(true);
    expect(base.versions.get('global')).toBe(1);
    expect(inst.bus.businessEventCounters().HELP_ENTRY_PUBLISHED).toBe(1);
  });

  it('le corpus relu déclenche la détection (loadHelpCorpus)', async () => {
    await demarrerInstance();
    const aide = await import('../../core/help-corpus.service');
    aide.resetHelpCorpusCacheForTests();
    const corpus = (version: string) => ({ schema: 'verebona-help-t2-v1', version, environment: 'test', articles: [] });
    const env = process.env.NEXT_PUBLIC_APP_ENV;
    process.env.NEXT_PUBLIC_APP_ENV = 'test';
    // Lot 34G : site public de l'environnement (local).
    const site = process.env.NEXT_PUBLIC_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_PUBLIC_SITE_URL = 'http://localhost:3000';
    process.env.VEREBONA_ASSISTANT_HELP_CACHE_TTL_SECONDS = '1';
    let v = 'v1';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(corpus(v)), { status: 200 }));
    const { resetAssistantConfigForTests } = await import('../../config/assistant-config');
    resetAssistantConfigForTests();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    await aide.loadHelpCorpus();
    v = 'v2';
    now.mockReturnValue(1_000_000 + 5_000);
    await aide.loadHelpCorpus();
    expect(base.versions.get('global')).toBe(1);
    now.mockRestore();
    fetchMock.mockRestore();
    process.env.NEXT_PUBLIC_APP_ENV = env;
    if (site === undefined) delete process.env.NEXT_PUBLIC_PUBLIC_SITE_URL; else process.env.NEXT_PUBLIC_PUBLIC_SITE_URL = site;
    delete process.env.VEREBONA_ASSISTANT_HELP_CACHE_TTL_SECONDS;
    resetAssistantConfigForTests();
  });
});
