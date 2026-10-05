/**
 * Lot 23 — caches : invalidation partagée multi-instances, journalisation
 * (auteur, date, motif), état (CDC Assistant §31.7, §32.6, §32.7, CA-30).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {}, ensureMigrations: vi.fn(async () => {}) }));

const { SharedCacheInvalidator } = await import('../shared-cache-invalidation');
const A = await import('../cache-admin');
const retrieval = await import('@/services/verebona-assistant/core/retrieval-cache');
const help = await import('@/services/verebona-assistant/core/help-corpus.service');

/** Stockage partagé en mémoire : plusieurs « instances » sur la même base. */
function memoire() {
  const v: Record<string, number> = {};
  const raisons: string[] = [];
  return {
    v, raisons, panne: false,
    lus: [] as string[][],
    async readAll(scopes: string[]) { this.lus.push(scopes); if (this.panne) throw new Error('base indisponible'); return { ...v }; },
    async bump(scope: string, reason: string) { v[scope] = (v[scope] ?? 0) + 1; raisons.push(`${scope}:${reason}`); },
  };
}

afterEach(() => {
  A.setCacheAdminDbForTests(null);
  retrieval.setCacheVersionStoreForTests(null);
});

describe('invalidation partagée (toutes les instances)', () => {
  it('une invalidation sur A vide le cache local de B au tour suivant, une seule fois', async () => {
    const store = memoire();
    const videA = vi.fn();
    const videB = vi.fn();
    const a = new SharedCacheInvalidator(store).register('help-corpus', videA);
    const b = new SharedCacheInvalidator(store).register('help-corpus', videB).register('pricing', vi.fn());
    expect(await b.poll()).toEqual([]); // première lecture : référence, rien n'est vidé
    expect(await a.poll()).toEqual([]);
    await a.invalidate('help-corpus', 'admin:1');
    expect(videA).toHaveBeenCalledTimes(1); // l'instance qui reçoit le clic vide tout de suite
    expect(await b.poll()).toEqual(['help-corpus']);
    expect(videB).toHaveBeenCalledTimes(1);
    expect(await b.poll()).toEqual([]);
    expect(await a.poll()).toEqual([]); // A ne revide pas sa propre invalidation
    expect(store.v['cache:help-corpus']).toBe(1);
    // M-1 : seuls les périmètres enregistrés sont relus (clé primaire).
    expect(store.lus.at(-1)).toEqual(['cache:help-corpus']);
  });

  it('versions illisibles : rien n’est vidé, reprise au tour suivant', async () => {
    const store = memoire();
    const vide = vi.fn();
    const b = new SharedCacheInvalidator(store).register('prompts', vide);
    await b.poll();
    await store.bump('cache:prompts', 'x');
    store.panne = true;
    expect(await b.poll()).toEqual([]);
    store.panne = false;
    expect(await b.poll()).toEqual(['prompts']);
    expect(vide).toHaveBeenCalledTimes(1);
  });
});

describe('invalidateAdminCache — contrôle, effet, journal', () => {
  let audit: ReturnType<typeof vi.fn>;
  let store: ReturnType<typeof memoire>;
  let inv: InstanceType<typeof SharedCacheInvalidator>;
  beforeEach(() => {
    audit = vi.fn(async () => undefined);
    store = memoire();
    inv = A.registerLocalCaches(new SharedCacheInvalidator(store));
  });

  it('refuse un cache inconnu et un motif absent ou trop court', async () => {
    await expect(A.invalidateAdminCache({ cacheId: 'tout', reason: 'motif valable', adminId: 1 }, { invalidator: inv, audit }))
      .rejects.toMatchObject({ code: 'UNKNOWN_CACHE', status: 400 });
    await expect(A.invalidateAdminCache({ cacheId: 'help-corpus', reason: '  ok ', adminId: 1 }, { invalidator: inv, audit }))
      .rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    expect(audit).not.toHaveBeenCalled();
  });

  it('corpus d’aide : version partagée incrémentée, cache local vidé, dernier valide conservé, journal SUCCESS', async () => {
    help.setHelpCorpusForTests({ version: 'v1', environment: 'local', articles: [] } as never);
    const r = await A.invalidateAdminCache({ cacheId: 'help-corpus', reason: 'Articles republiés', adminId: 7, adminEmail: 'a@x' }, { invalidator: inv, audit });
    expect(r).toEqual({ cache: 'help-corpus', effect: { scope: 'cache:help-corpus' } });
    expect(store.raisons).toEqual(['cache:help-corpus:admin:7']);
    expect(help.helpCorpusHealth().version).toBeNull(); // relu au prochain accès
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      adminId: 7, adminEmail: 'a@x', action: 'AI_CACHE_INVALIDATE', targetType: 'AI_CACHE', result: 'SUCCESS',
      after: { cache: 'help-corpus', reason: 'Articles republiés' },
    }));
  });

  it('retrieval : version GLOBALE incrémentée (clé de toutes les instances)', async () => {
    const versions = memoire();
    retrieval.setCacheVersionStoreForTests({ read: async () => ({}), bump: (s, r) => versions.bump(s, r) });
    await A.invalidateAdminCache({ cacheId: 'retrieval', reason: 'Données corrigées en base', adminId: 3 }, { invalidator: inv, audit });
    expect(versions.raisons).toEqual(['global:admin:3']);
  });

  it('familles d’idempotence : suppression ciblée, clés réservées toujours exclues', async () => {
    const deleteRows = vi.fn(async () => ({ rows: 12, partial: false }));
    A.setCacheAdminDbForTests({ read: async () => [], deleteRows });
    const r = await A.invalidateAdminCache({ cacheId: 'gateway-idempotency', reason: 'Schéma de sortie modifié', adminId: 2 }, { invalidator: inv, audit });
    expect(r.effect).toEqual({ scope: 'cache:gateway-idempotency', rowsDeleted: 12 });
    const where = String((deleteRows.mock.calls as unknown as string[][])[0][0]);
    expect(where).toMatch(/NOT LIKE 'help-corpus:last-valid:%'/);
    expect(where).toMatch(/NOT LIKE 'assistant:%'/);
    expect(where).toMatch(/NOT LIKE 't4-temporal:%'/);
    await A.invalidateAdminCache({ cacheId: 't4-temporal', reason: 'Règle de dates revue', adminId: 2 }, { invalidator: inv, audit });
    expect(String((deleteRows.mock.calls as unknown as string[][])[1][0])).toBe(`key_hash LIKE 't4-temporal:%'`);
    expect(audit.mock.calls.map((c) => (c as unknown as [{ details: { rowsDeleted?: number } }])[0].details.rowsDeleted)).toEqual([12, 12]);
  });

  it('suppression interrompue par la borne de temps : partial au résultat et au journal', async () => {
    A.setCacheAdminDbForTests({ read: async () => [], deleteRows: async () => ({ rows: 5000, partial: true }) });
    const r = await A.invalidateAdminCache({ cacheId: 'gateway-idempotency', reason: 'Schéma de sortie modifié', adminId: 2 }, { invalidator: inv, audit });
    expect(r.effect).toMatchObject({ rowsDeleted: 5000, partial: true });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ result: 'SUCCESS', details: expect.objectContaining({ partial: true }) }));
  });

  it('échec technique : journal FAILURE puis erreur remontée', async () => {
    A.setCacheAdminDbForTests({ read: async () => [], deleteRows: async () => { throw new Error('verrou'); } });
    // (cas d'échec franc ; le cas « borne de temps atteinte » est testé ci-dessous)
    await expect(A.invalidateAdminCache({ cacheId: 't4-temporal', reason: 'Règle de dates revue', adminId: 2 }, { invalidator: inv, audit }))
      .rejects.toThrow('verrou');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ result: 'FAILURE', details: expect.objectContaining({ error: 'verrou' }) }));
  });
});

describe('getCachesState', () => {
  it('inventaire complet : nature, version, volumes, âge, dernière invalidation', async () => {
    const now = new Date('2026-10-05T10:00:00Z');
    A.setCacheAdminDbForTests({
      deleteRows: async () => ({ rows: 0, partial: false }),
      read: async (sql: string) => {
        if (/FROM verebona_cache_versions WHERE scope = ANY/.test(sql)) {
          return [{ scope: 'global', version: 4, last_reason: 'admin:1', updated_at: '2026-10-05T09:00:00Z' }];
        }
        if (/scope LIKE 'account:%'/.test(sql)) return [{ n: 12 }];
        if (/GROUP BY 1/.test(sql)) return [{ famille: 't4-temporal', n: 3, expirees: 1, plus_ancienne: '2026-10-04T10:00:00Z' }];
        if (/AI_CACHE_INVALIDATE/.test(sql)) return [{ cache: 'retrieval', timestamp: '2026-10-05T09:00:00Z', admin_email: 'a@x', reason: 'test' }];
        return [];
      },
    });
    const r = await A.getCachesState(now);
    expect(r.caches.map((c) => c.id)).toEqual([...A.ADMIN_CACHE_IDS]);
    const ret = r.caches.find((c) => c.id === 'retrieval')!;
    expect(ret).toMatchObject({ version: 4, ageSeconds: 3600, lastInvalidation: { admin: 'a@x', reason: 'test' } });
    expect(ret.volume).toContainEqual({ label: 'comptes versionnés', value: 12 });
    const t4 = r.caches.find((c) => c.id === 't4-temporal')!;
    expect(t4).toMatchObject({ version: 0, ageSeconds: 86_400 });
    expect(t4.volume).toEqual([{ label: 'lignes', value: 3 }, { label: 'expirées (purge quotidienne)', value: 1 }]);
    expect(r.caches.every((c) => c.nature && c.invalidation)).toBe(true);
  });

  it('lecture impossible : volumes « non mesurables », motif dans les notes, jamais d’échec', async () => {
    A.setCacheAdminDbForTests({ deleteRows: async () => ({ rows: 0, partial: false }), read: async () => { throw new Error('délai dépassé'); } });
    const r = await A.getCachesState();
    expect(r.caches.find((c) => c.id === 'gateway-idempotency')!.volume[0].value).toBeNull();
    expect(r.notes.join(' ')).toMatch(/délai dépassé/);
  });
});
