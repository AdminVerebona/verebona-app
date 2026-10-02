/**
 * PUB-01 (CDC Centre d'aide V1) — un corpus publié invalide ou d'un autre
 * environnement ne devient jamais la référence : l'assistant garde le
 * dernier corpus valide (mémoire, puis base), et l'incident est signalé.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HelpCorpus, HelpCorpusStore } from '../help-corpus.service';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => { throw new Error('aucune requête base attendue'); }) },
  ensureUnaccent: vi.fn(async () => {}),
}));
vi.mock('../../events/business-events', () => ({ emitBusinessEvent: vi.fn(async () => {}) }));

const {
  loadHelpCorpus, helpCorpusHealth, resetHelpCorpusCacheForTests, setHelpCorpusStoreForTests, searchHelpCorpus,
} = await import('../help-corpus.service');

/** Ancien format (avant D-O) : ni statut ni date de validation. */
const ancien = (version: string) => {
  const c = corpus(version) as unknown as { articles: Array<Record<string, unknown>> };
  return { ...c, articles: c.articles.map(({ status: _s, validatedAt: _v, ...a }) => a) };
};

const corpus = (version: string, environment = 'preprod'): HelpCorpus => ({
  schema: 'verebona-help-t2-v1', version, environment,
  articles: [{
    id: 'AID-1', title: 'Ajouter un document', status: 'published', validatedAt: '2026-09-01', path: '/aide/ajouter-un-document', category: 'documents',
    categoryName: 'Documents', summary: 's', offers: ['standard'], offersLabel: 'Toutes', offersNote: null,
    synonyms: [], sections: [{ anchor: 'a', heading: 'h', text: 't' }],
  }],
});

let reponse: () => Promise<Response>;
const memoire = new Map<string, { corpus: unknown; at: string }>();
const store: HelpCorpusStore = {
  read: vi.fn(async (env: string) => memoire.get(env) ?? null),
  write: vi.fn(async (env: string, c: HelpCorpus) => { memoire.set(env, { corpus: c, at: '2026-09-01T00:00:00.000Z' }); }),
};
const json = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

/** Force la relecture (le cache est valable 24 h). */
async function relire() {
  vi.setSystemTime(Date.now() + 2 * 86_400_000);
  return loadHelpCorpus();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  process.env.NEXT_PUBLIC_APP_ENV = 'preprod';
  resetHelpCorpusCacheForTests();
  memoire.clear();
  vi.mocked(store.write).mockClear();
  setHelpCorpusStoreForTests(store);
  vi.stubGlobal('fetch', vi.fn(() => reponse()));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setHelpCorpusStoreForTests(null);
  delete process.env.NEXT_PUBLIC_APP_ENV;
});

describe('PUB-01 — dernier corpus valide', () => {
  it('corpus valide : servi, enregistré en base, aucune alerte', async () => {
    reponse = json(corpus('v1'));
    expect((await loadHelpCorpus())?.version).toBe('v1');
    expect(helpCorpusHealth()).toMatchObject({ status: 'ok', source: 'live', version: 'v1', alert: null });
    await vi.waitFor(() => expect(store.write).toHaveBeenCalledTimes(1));
    expect(memoire.get('preprod')).toBeTruthy();
  });

  it('corpus publié INVALIDE : le dernier valide reste servi, alerte levée', async () => {
    reponse = json(corpus('v1'));
    await loadHelpCorpus();
    reponse = json({ schema: 'verebona-help-t2-v1', version: 'v2', environment: 'preprod', articles: [{ id: 3 }] });
    expect((await relire())?.version).toBe('v1');
    expect(helpCorpusHealth()).toMatchObject({
      status: 'warning', source: 'last_valid_memory', version: 'v1', alert: { code: 'HELP_CORPUS_INVALID' },
    });
  });

  it('corpus d’un AUTRE environnement (ENV-02) : refusé, dernier valide servi', async () => {
    reponse = json(corpus('v1'));
    await loadHelpCorpus();
    reponse = json(corpus('v9', 'production'));
    expect((await relire())?.version).toBe('v1');
    expect(helpCorpusHealth().alert?.code).toBe('HELP_CORPUS_WRONG_ENVIRONMENT');
  });

  it('instance qui redémarre sur un corpus refusé : dernier valide relu EN BASE', async () => {
    memoire.set('preprod', { corpus: corpus('v0'), at: '2026-09-01T00:00:00.000Z' });
    reponse = async () => new Response('<html>pas du json', { status: 200 });
    expect((await loadHelpCorpus())?.version).toBe('v0');
    expect(helpCorpusHealth()).toMatchObject({ status: 'warning', source: 'last_valid_db', lastValidAt: '2026-09-01T00:00:00.000Z' });
    expect(helpCorpusHealth().lastValidAgeSeconds).toBe(Math.round((Date.now() - Date.parse('2026-09-01T00:00:00.000Z')) / 1000));
  });

  it('corpus en base d’un autre environnement : jamais servi', async () => {
    memoire.set('preprod', { corpus: corpus('v0', 'production'), at: '2026-09-01T00:00:00.000Z' });
    reponse = json(corpus('v9', 'production'));
    expect(await loadHelpCorpus()).toBeNull();
    expect(helpCorpusHealth()).toMatchObject({ status: 'warning', source: 'none' });
  });

  it('corpus injoignable : dernier valide servi, alerte « indisponible »', async () => {
    reponse = json(corpus('v1'));
    await loadHelpCorpus();
    reponse = async () => { throw new Error('ECONNREFUSED'); };
    expect((await relire())?.version).toBe('v1');
    expect(helpCorpusHealth().alert?.code).toBe('HELP_CORPUS_UNAVAILABLE');
    reponse = async () => new Response('', { status: 404 });
    expect((await relire())?.version).toBe('v1');
  });

  it('retour d’un corpus valide : alerte levée, nouvelle version enregistrée', async () => {
    reponse = json(corpus('v1'));
    await loadHelpCorpus();
    reponse = json({ schema: 'autre' });
    await relire();
    reponse = json(corpus('v2'));
    expect((await relire())?.version).toBe('v2');
    expect(helpCorpusHealth()).toMatchObject({ status: 'ok', source: 'live', alert: null });
    await vi.waitFor(() => expect(store.write).toHaveBeenCalledTimes(2));
  });

  it('jamais lu : état inconnu', () => {
    expect(helpCorpusHealth()).toMatchObject({ status: 'unknown', source: 'none' });
  });

  it('clé de stockage RÉSERVÉE : exclue de toute purge de la table', async () => {
    const { HELP_CORPUS_STORE_KEY_PREFIX } = await import('../help-corpus.service');
    const { isReservedIdempotencyKey, NOT_RESERVED_IDEMPOTENCY_KEY_SQL } = await import('@/services/ai/idempotency/idempotency.service');
    expect(isReservedIdempotencyKey(`${HELP_CORPUS_STORE_KEY_PREFIX}production`)).toBe(true);
    expect(NOT_RESERVED_IDEMPOTENCY_KEY_SQL).toContain(`NOT LIKE '${HELP_CORPUS_STORE_KEY_PREFIX}%'`);
  });

  it('D-O : corpus publié avec des articles mais AUCUN citable → invalide, « à republier », repli, jamais enregistré', async () => {
    reponse = json(corpus('v1'));
    await loadHelpCorpus();
    await vi.waitFor(() => expect(store.write).toHaveBeenCalledTimes(1));
    reponse = json(ancien('v2'));
    expect((await relire())?.version).toBe('v1');
    expect(helpCorpusHealth()).toMatchObject({ status: 'warning', source: 'last_valid_memory', alert: { code: 'HELP_CORPUS_INVALID' } });
    expect(helpCorpusHealth().alert!.message).toMatch(/corpus d’aide à republier/);
    expect(store.write).toHaveBeenCalledTimes(1);
    expect((memoire.get('preprod')!.corpus as { version: string }).version).toBe('v1');
  });

  it('transition : copie EN BASE à l’ancien format servie avec l’ancienne règle (jamais vidée), alerte « à republier »', async () => {
    memoire.set('preprod', { corpus: ancien('v0'), at: '2026-09-01T00:00:00.000Z' });
    reponse = json(ancien('v2'));
    const c = await loadHelpCorpus();
    expect(c?.version).toBe('v0');
    expect(c?.articles).toHaveLength(1);
    expect(c?.legacyPublication).toBe(true);
    expect(searchHelpCorpus(c!, 'ajouter un document')).toHaveLength(1);
    expect(helpCorpusHealth()).toMatchObject({ status: 'warning', source: 'last_valid_db' });
    expect(helpCorpusHealth().alert!.message).toMatch(/ancien format.*corpus d’aide à republier/);
    // Relecture suivante (mémoire) : toujours signalé.
    reponse = async () => { throw new Error('ECONNRESET'); };
    expect((await relire())?.version).toBe('v0');
    expect(helpCorpusHealth().alert!.message).toMatch(/à republier/);
    expect(store.write).not.toHaveBeenCalled();
  });

  it('corpus en direct à l’ancien format : jamais servi avec l’ancienne règle', async () => {
    reponse = json(ancien('v2'));
    expect(await loadHelpCorpus()).toBeNull();
    expect(helpCorpusHealth()).toMatchObject({ status: 'warning', source: 'none' });
  });
});

