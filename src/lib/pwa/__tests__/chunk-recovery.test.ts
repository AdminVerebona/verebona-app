/**
 * APP-PERF-10 — reprise PWA bornée après erreur de chunk ou déploiement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import vm from 'node:vm';
import {
  RECOVERY_STORAGE_KEY,
  RECOVERY_WINDOW_MS,
  __setRecoveryEnvForTests,
  decideRecovery,
  getRecoveryState,
  handleChunkError,
  isChunkLoadError,
  onNetworkRestored,
  recoveryMessage,
  registerReloadBlocker,
  reportServiceWorkerChunkProblem,
  type RecoveryStorage,
} from '../chunk-recovery';

function memoryStorage(): RecoveryStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

describe('détection', () => {
  it('reconnaît les erreurs de chunk JS, CSS et d’import dynamique', () => {
    expect(isChunkLoadError({ name: 'ChunkLoadError', message: '' })).toBe(true);
    expect(isChunkLoadError(new Error('Loading chunk 123 failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Loading CSS chunk 4 failed'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /x.js'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe('décision (pure)', () => {
  const base = { online: true, now: 1_000_000, blockedBy: [] as string[] };

  it('première erreur, en ligne : une tentative automatique', () => {
    expect(decideRecovery({ ...base, cause: 'missing', storage: memoryStorage() })).toEqual({ action: 'reload', cause: 'missing' });
  });

  it('seconde erreur dans la fenêtre : reprise explicite, pas de reload', () => {
    const s = memoryStorage();
    s.setItem(RECOVERY_STORAGE_KEY, JSON.stringify({ at: base.now - 1_000, href: '/x' }));
    expect(decideRecovery({ ...base, cause: 'missing', storage: s })).toMatchObject({ action: 'prompt', alreadyRetried: true });
  });

  it('après la fenêtre : un nouvel incident a droit à sa tentative', () => {
    const s = memoryStorage();
    s.setItem(RECOVERY_STORAGE_KEY, JSON.stringify({ at: base.now - RECOVERY_WINDOW_MS - 1, href: '/x' }));
    expect(decideRecovery({ ...base, cause: 'missing', storage: s }).action).toBe('reload');
  });

  it('stockage indisponible : jamais de reload automatique (boucle impossible à exclure)', () => {
    expect(decideRecovery({ ...base, cause: 'missing', storage: null }).action).toBe('prompt');
  });

  it('hors ligne ou transport en échec : attente du réseau, pas de reload', () => {
    expect(decideRecovery({ ...base, cause: 'network', storage: memoryStorage() }).action).toBe('offline');
    expect(decideRecovery({ ...base, online: false, cause: 'missing', storage: memoryStorage() }).action).toBe('offline');
  });

  it('saisie ou envoi en cours : reprise proposée avec avertissement', () => {
    const d = decideRecovery({ ...base, cause: 'missing', storage: memoryStorage(), blockedBy: ['envoi'] });
    expect(d).toMatchObject({ action: 'prompt', blockedBy: ['envoi'] });
    const msg = recoveryMessage(d);
    expect(msg.detail).toContain('envoi est en cours');
    expect(msg.button).toBe('Recharger quand même');
  });

  it('CA-02 : 404, réseau et nouvelle version ont des messages distincts', () => {
    const missing = recoveryMessage({ action: 'prompt', cause: 'missing', blockedBy: [], alreadyRetried: true });
    const offline = recoveryMessage({ action: 'offline', cause: 'network' });
    const version = recoveryMessage({ action: 'prompt', cause: 'new-version', blockedBy: [], alreadyRetried: false });
    const titres = new Set([missing.title, offline.title, version.title]);
    expect(titres.size).toBe(3);
    expect(offline.button).toBeNull();
  });
});

describe('coordination (incident simulé sur plusieurs chargements de page)', () => {
  let storage: ReturnType<typeof memoryStorage>;
  let reloads: number;
  let online: boolean;
  let now: number;

  function nouvellePage() {
    // Chaque chargement de page repart d'un module neuf, la session reste.
    __setRecoveryEnvForTests({
      now: () => now,
      online: () => online,
      storage: () => storage,
      reload: () => { reloads += 1; },
      href: () => 'https://app/documents',
    });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    storage = memoryStorage();
    reloads = 0;
    online = true;
    now = 5_000_000;
  });
  afterEach(() => {
    vi.useRealTimers();
    __setRecoveryEnvForTests(null);
  });

  it('T-01 / CA-01 : 404 permanent → un seul reload, puis reprise explicite, sans boucle', () => {
    for (let page = 0; page < 5; page++) {
      nouvellePage();
      reportServiceWorkerChunkProblem('missing');
      handleChunkError();
      handleChunkError(); // erreur globale + rejet pour le même chunk
      vi.runAllTimers();
      now += 2_000;
    }
    expect(reloads).toBe(1);
    expect(JSON.parse(storage.data.get(RECOVERY_STORAGE_KEY)!).href).toBe('https://app/documents');
    expect(getRecoveryState().decision).toMatchObject({ action: 'prompt', cause: 'missing', alreadyRetried: true });
  });

  it('T-02 : hors ligne → aucune tentative ; retour du réseau → reprise proposée', () => {
    nouvellePage();
    online = false;
    reportServiceWorkerChunkProblem('network');
    expect(handleChunkError().action).toBe('offline');
    vi.runAllTimers();
    expect(reloads).toBe(0);
    online = true;
    onNetworkRestored();
    expect(getRecoveryState().decision).toMatchObject({ action: 'prompt', cause: 'network' });
    expect(reloads).toBe(0);
  });

  it('signal réseau du SW récent : classé « réseau » même si navigator.onLine ment', () => {
    nouvellePage();
    reportServiceWorkerChunkProblem('network');
    expect(handleChunkError().action).toBe('offline');
  });

  it('T-03 : envoi en cours → pas de reload automatique', () => {
    nouvellePage();
    let enCours = 1;
    registerReloadBlocker('envoi', () => enCours > 0);
    expect(handleChunkError()).toMatchObject({ action: 'prompt', blockedBy: ['envoi'] });
    vi.runAllTimers();
    expect(reloads).toBe(0);
    enCours = 0;
  });

  it('un 404 vu par le SW seul (préchargement) propose la version, sans recharger', () => {
    nouvellePage();
    reportServiceWorkerChunkProblem('missing');
    vi.runAllTimers();
    expect(reloads).toBe(0);
    expect(getRecoveryState().decision).toMatchObject({ action: 'prompt', cause: 'new-version' });
  });

  it('écran d’erreur (inline) : pas de bandeau en double pour une reprise proposée', () => {
    nouvellePage();
    storage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify({ at: now, href: '/' }));
    expect(handleChunkError({ inline: true }).action).toBe('prompt');
    expect(getRecoveryState().decision).toBeNull();
  });
});

// ── Service worker ─────────────────────────────────────────────────────────

describe('public/sw.js', () => {
  const SOURCE = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf-8');

  function chargerSw(fetchImpl: (req: unknown) => Promise<unknown>) {
    const listeners: Record<string, (e: unknown) => void> = {};
    const messages: unknown[] = [];
    const deleted: string[] = [];
    const self = {
      addEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = fn; },
      clients: { matchAll: async () => [{ postMessage: (m: unknown) => messages.push(m) }], claim: async () => undefined },
      registration: {},
      location: { origin: 'https://app' },
      skipWaiting: () => undefined,
    };
    const caches = {
      keys: async () => ['verebona-v5.0.0', 'verebona-static-v5.1.0', 'autre-bibliotheque'],
      delete: async (n: string) => { deleted.push(n); return true; },
    };
    vm.runInNewContext(SOURCE, {
      self, caches, fetch: fetchImpl, Response, Request, URL, location: { origin: 'https://app' }, console, Date, Map, Promise,
    });
    return { listeners, messages, deleted };
  }

  async function demander(sw: ReturnType<typeof chargerSw>, path: string) {
    let responded: Promise<unknown> | null = null;
    sw.listeners.fetch({
      request: { url: `https://app${path}`, method: 'GET', headers: new Headers({ accept: '*/*' }) },
      respondWith: (p: Promise<unknown>) => { responded = p; },
    });
    const result = await (responded as unknown as Promise<unknown>).then((r) => r, (e) => e);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    return result;
  }

  it('un 404 HTTP de chunk est signalé « missing » (ce n’est pas un rejet réseau)', async () => {
    const sw = chargerSw(async () => new Response('', { status: 404 }));
    const res = await demander(sw, '/_next/static/chunks/abc.js') as Response;
    expect(res.status).toBe(404);
    expect(sw.messages).toEqual([expect.objectContaining({ type: 'CHUNK_LOAD_ERROR', reason: 'missing', status: 404 })]);
  });

  it('un échec de transport est signalé « network » et reste une erreur réseau (plus de faux 408)', async () => {
    const sw = chargerSw(async () => { throw new TypeError('Failed to fetch'); });
    const res = await demander(sw, '/_next/static/chunks/def.js');
    expect(res).toBeInstanceOf(TypeError);
    expect(sw.messages).toEqual([expect.objectContaining({ reason: 'network' })]);
  });

  it('un chunk servi normalement ne signale rien ; signalements dédoublonnés', async () => {
    const ok = chargerSw(async () => new Response('x', { status: 200 }));
    await demander(ok, '/_next/static/chunks/ok.js');
    expect(ok.messages).toEqual([]);
    const ko = chargerSw(async () => new Response('', { status: 404 }));
    await demander(ko, '/_next/static/chunks/a.js');
    await demander(ko, '/_next/static/chunks/a.js');
    expect(ko.messages).toHaveLength(1);
  });

  it('CLEAR_CACHE ne vide que les caches de ce SW', async () => {
    const sw = chargerSw(async () => new Response(''));
    let wait: Promise<unknown> = Promise.resolve();
    sw.listeners.message({ data: { type: 'CLEAR_CACHE' }, waitUntil: (p: Promise<unknown>) => { wait = p; } });
    await wait;
    expect(sw.deleted.sort()).toEqual(['verebona-static-v5.1.0', 'verebona-v5.0.0']);
  });

  it('les notifications push restent gérées (CA-03)', () => {
    const sw = chargerSw(async () => new Response(''));
    for (const t of ['push', 'notificationclick', 'pushsubscriptionchange']) expect(typeof sw.listeners[t]).toBe('function');
  });
});
