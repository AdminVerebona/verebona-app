/**
 * Lot 112E — l'identifiant d'installation n'est JAMAIS régénéré parce que le
 * stockage sécurisé est momentanément illisible (téléphone verrouillé,
 * errSecInteractionNotAllowed, erreur du Keystore Android).
 *
 *   L112E-DECIDE  décision pure (use / create / defer) ;
 *   L112E-PROBE   sonde native iOS et lecture `secureRead` ;
 *   L112E-INIT    `initInstallationId` avec coque factice (report, reprise,
 *                 réinstallation, concurrence, journal sans valeur).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  INSTALLATION_CONFIRM_REREAD_MS, INSTALLATION_RETRY_AFTER_ERROR_MS, decideInstallationId, resolveInstallationId,
  type InstallationDeps, type InstallationRead,
} from '@/lib/native/installation-id';
import { SECURE_KEYS, SECURE_PREFIX, parseSecureProbe, secureRead } from '@/lib/native/secure-store';
import {
  INSTALLATION_ID_READY_EVENT, INSTALL_MARKER_KEY, __resetShellInfoForTests, initInstallationId, runtimeShellInfo,
} from '@/lib/native/shell-info';
import { UNLOCK_JOURNAL_KEY, readUnlockJournal } from '@/lib/native/unlock-journal';

const KEY = `${SECURE_PREFIX}${SECURE_KEYS.installationId}`;
const ID = 'id-installation-existant-0001';
const UA = 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 VerebonaApp/1.4.0 (52; preprod)';

// ── Coque factice ────────────────────────────────────────────────────────────

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

type Listener = (d: unknown) => void;
function emitter() {
  const ls = new Map<string, Listener[]>();
  return {
    addListener: vi.fn((e: string, cb: Listener) => {
      ls.set(e, [...(ls.get(e) ?? []), cb]);
      return { remove: () => ls.set(e, (ls.get(e) ?? []).filter((x) => x !== cb)) };
    }),
    emit: (e: string, d: unknown) => { for (const cb of ls.get(e) ?? []) cb(d); },
    count: (e: string) => (ls.get(e) ?? []).length,
  };
}

/**
 * Keychain / Keystore factice. `locked` : comportement réel du plugin npm sur
 * iOS (toute erreur → « absent ») ; `throws` : comportement Android (rejet).
 */
function fakeDevice(o: { platform?: 'ios' | 'android'; probe?: boolean; app?: boolean } = {}) {
  const store = new Map<string, string>();
  const st = { locked: false, throws: false, active: true };
  const secure = {
    internalGetItem: vi.fn(async ({ prefixedKey }: { prefixedKey: string }) => {
      if (st.throws) throw Object.assign(new Error('An OS error occurred (KeyStoreException)'), { code: 'osError' });
      return { data: st.locked ? null : store.get(prefixedKey) ?? null };
    }),
    internalSetItem: vi.fn(async ({ prefixedKey, data }: { prefixedKey: string; data: string }) => {
      if (st.locked || st.throws) throw Object.assign(new Error('An OS error occurred (-25308)'), { code: 'osError' });
      store.set(prefixedKey, data);
    }),
    internalRemoveItem: vi.fn(async ({ prefixedKey }: { prefixedKey: string }) => ({ success: store.delete(prefixedKey) })),
    internalClearItemsWithPrefix: vi.fn(async ({ prefix }: { prefix: string }) => {
      for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
    }),
  };
  const statusEvents = emitter();
  const status = {
    ...statusEvents,
    probe: vi.fn(async ({ prefixedKey }: { prefixedKey: string }) => {
      if (st.locked) return { status: 'locked', osStatus: -25308, protectedDataAvailable: false };
      return store.has(prefixedKey)
        ? { status: 'present', osStatus: 0, protectedDataAvailable: true }
        : { status: 'absent', osStatus: -25300, protectedDataAvailable: true };
    }),
  };
  const appEvents = emitter();
  const app = { ...appEvents, getState: vi.fn(async () => ({ isActive: st.active })) };
  const plugins: Record<string, unknown> = { SecureStorage: secure };
  if (o.probe) plugins.VerebonaSecureStoreStatus = status;
  if (o.app !== false) plugins.App = app;
  const win = Object.assign(new EventTarget(), {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => o.platform ?? 'ios', Plugins: plugins },
    location: { protocol: 'https:', origin: 'https://app.preprod.verebona.fr', pathname: '/accueil', search: '' },
  });
  vi.stubGlobal('window', win);
  vi.stubGlobal('navigator', { userAgent: UA, standalone: false });
  return { store, st, secure, status, app, win };
}

let ls: ReturnType<typeof memoryStorage>;
beforeEach(() => {
  ls = memoryStorage();
  vi.stubGlobal('localStorage', ls);
  __resetShellInfoForTests();
});
afterEach(() => {
  __resetShellInfoForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

// ── Décision pure ────────────────────────────────────────────────────────────

describe('L112E-DECIDE — jamais « créer » sur une lecture incertaine', () => {
  const r = (o: Partial<InstallationRead>): InstallationRead => ({ ok: true, value: null, ...o });

  it('valeur lue et valide, installation initialisée : réutilisée (même app en arrière-plan)', () => {
    expect(decideInstallationId({ marker: true, read: r({ value: ID }), foreground: false })).toEqual({ action: 'use', id: ID });
  });

  it('Keychain verrouillé (sonde) ou Keystore en erreur : report, jamais de création', () => {
    for (const marker of [true, false]) {
      for (const foreground of [true, false, null]) {
        expect(decideInstallationId({ marker, read: r({ ok: false, failure: 'locked' }), foreground }))
          .toEqual({ action: 'defer', reason: 'locked' });
        expect(decideInstallationId({ marker, read: r({ ok: false, failure: 'storage_error' }), foreground }))
          .toEqual({ action: 'defer', reason: 'storage_error' });
      }
    }
  });

  it('binaire sans sonde, lecture vide en arrière-plan : report (téléphone peut-être verrouillé)', () => {
    expect(decideInstallationId({ marker: true, read: r({}), foreground: false })).toEqual({ action: 'defer', reason: 'background' });
    // Marqueur absent (réinstallation présumée) : JAMAIS de purge en arrière-plan sans preuve.
    expect(decideInstallationId({ marker: false, read: r({}), foreground: false })).toEqual({ action: 'defer', reason: 'background' });
  });

  it('binaire sans sonde au premier plan : création après seconde lecture de confirmation', () => {
    expect(decideInstallationId({ marker: true, read: r({}), foreground: true }))
      .toEqual({ action: 'create', purge: false, confirm: true, persist: true });
  });

  it('sonde « absent » (déverrouillé) : création sans attendre, même en arrière-plan', () => {
    const probe = { status: 'absent' as const, osStatus: -25300, protectedDataAvailable: true };
    expect(decideInstallationId({ marker: true, read: r({ probe }), foreground: false }))
      .toEqual({ action: 'create', purge: false, confirm: false, persist: true });
  });

  it('réinstallation (AUTH-13) : marqueur absent + Keychain lisible → purge puis nouvel identifiant', () => {
    expect(decideInstallationId({ marker: false, read: r({ value: ID }), foreground: false }))
      .toEqual({ action: 'create', purge: true, confirm: false, persist: true });
    expect(decideInstallationId({ marker: false, read: r({}), foreground: true }))
      .toEqual({ action: 'create', purge: true, confirm: false, persist: true });
  });

  it('valeur abîmée lue : remplacée (lecture probante)', () => {
    expect(decideInstallationId({ marker: true, read: r({ value: 'court' }), foreground: false }))
      .toEqual({ action: 'create', purge: false, confirm: false, persist: true });
  });
});

describe('L112E-DECIDE — orchestration (dépendances injectées)', () => {
  function deps(reads: InstallationRead[], fg: Array<boolean | null>, o: Partial<InstallationDeps> = {}) {
    const log: string[] = [];
    const d: InstallationDeps = {
      readMarker: () => true,
      writeMarker: vi.fn(),
      read: vi.fn(async () => reads.shift() ?? { ok: true, value: null }),
      foreground: vi.fn(async () => (fg.length > 1 ? fg.shift()! : fg[0] ?? null)),
      clearAll: vi.fn(async () => { log.push('clear'); }),
      write: vi.fn(async () => true),
      newId: () => 'nouvel-identifiant-000000000001',
      sleep: vi.fn(async () => {}),
      journal: vi.fn(),
      ...o,
    };
    return { d, log };
  }

  it('seconde lecture qui trouve la valeur (déverrouillage entre-temps) : aucune création', async () => {
    const { d } = deps([{ ok: true, value: null }, { ok: true, value: ID }], [true]);
    expect(await resolveInstallationId(d)).toEqual({ kind: 'ready', id: ID, created: false, purged: false, persisted: true });
    expect(d.sleep).toHaveBeenCalledWith(INSTALLATION_CONFIRM_REREAD_MS);
    expect(d.write).not.toHaveBeenCalled();
  });

  it('app passée en arrière-plan pendant la confirmation : report', async () => {
    const { d } = deps([{ ok: true, value: null }, { ok: true, value: null }], [true, false]);
    expect(await resolveInstallationId(d)).toEqual({ kind: 'deferred', reason: 'background' });
    expect(d.write).not.toHaveBeenCalled();
    expect(d.writeMarker).not.toHaveBeenCalled();
  });

  it('report : ni purge, ni écriture, ni marqueur ; journal sans valeur', async () => {
    const { d, log } = deps([{ ok: false, value: null, failure: 'locked', probe: { status: 'locked', osStatus: -25308, protectedDataAvailable: false } }], [false],
      { readMarker: () => false });
    expect(await resolveInstallationId(d)).toEqual({ kind: 'deferred', reason: 'locked' });
    expect(log).toEqual([]);
    expect(d.write).not.toHaveBeenCalled();
    expect(d.writeMarker).not.toHaveBeenCalled();
    expect(d.journal).toHaveBeenCalledWith('deferred', expect.objectContaining({ reason: 'locked', osStatus: -25308, protectedData: false }));
  });
});

// ── Sonde native et lecture ─────────────────────────────────────────────────

describe('L112E-PROBE — code natif du Keychain', () => {
  it('normalisation : « absent » sans données protégées devient « verrouillé » ; réponse inattendue → erreur', () => {
    expect(parseSecureProbe({ status: 'absent', osStatus: -25300, protectedDataAvailable: false }).status).toBe('locked');
    expect(parseSecureProbe({ status: 'absent', osStatus: -25300, protectedDataAvailable: true }).status).toBe('absent');
    expect(parseSecureProbe({ status: 'locked', osStatus: -25308 })).toEqual({ status: 'locked', osStatus: -25308, protectedDataAvailable: null });
    expect(parseSecureProbe(null).status).toBe('error');
    expect(parseSecureProbe({ status: 'autre' }).status).toBe('error');
  });

  it('secureRead : « absent » du plugin npm contredit par la sonde (verrouillé) → échec de lecture', async () => {
    const dev = fakeDevice({ probe: true });
    dev.store.set(KEY, ID);
    dev.st.locked = true;
    const res = await secureRead(SECURE_KEYS.installationId);
    expect(res).toMatchObject({ ok: false, value: null, failure: 'locked' });
    dev.st.locked = false;
    expect(await secureRead(SECURE_KEYS.installationId)).toEqual({ ok: true, value: ID });
    dev.store.clear();
    expect(await secureRead(SECURE_KEYS.installationId)).toMatchObject({ ok: true, value: null, probe: { status: 'absent' } });
  });

  it('sans sonde (Android, binaire antérieur) : comportement 111D inchangé', async () => {
    const dev = fakeDevice({ platform: 'android' });
    expect(await secureRead(SECURE_KEYS.installationId)).toEqual({ ok: true, value: null });
    dev.st.throws = true;
    expect(await secureRead(SECURE_KEYS.installationId)).toEqual({ ok: false, value: null, failure: 'storage_error' });
  });
});

// ── initInstallationId sur coque factice ────────────────────────────────────

describe('L112E-INIT — identifiant conservé téléphone verrouillé', () => {
  it('iOS 112E, vue rechargée téléphone verrouillé : null, rien n’est écrit ; au déverrouillage, MÊME identifiant', async () => {
    const dev = fakeDevice({ probe: true });
    dev.store.set(KEY, ID);
    ls.setItem(INSTALL_MARKER_KEY, '1');
    dev.st.locked = true;
    dev.st.active = false;
    const ready = vi.fn();
    dev.win.addEventListener(INSTALLATION_ID_READY_EVENT, ready);

    expect(await initInstallationId()).toBeNull();
    expect(dev.secure.internalSetItem).not.toHaveBeenCalled();
    expect(dev.secure.internalClearItemsWithPrefix).not.toHaveBeenCalled();
    expect(runtimeShellInfo()?.installationId).toBeUndefined();
    expect(dev.status.count('protectedDataChange')).toBe(1);
    expect(dev.app.count('appStateChange')).toBe(1);

    // Déverrouillage (événement natif) : relecture, identifiant d'origine.
    dev.st.locked = false;
    dev.status.emit('protectedDataChange', { available: true });
    await flush();
    expect(await initInstallationId()).toBe(ID);
    expect(runtimeShellInfo()?.installationId).toBe(ID);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(dev.secure.internalSetItem).not.toHaveBeenCalled();
    // Abonnements retirés une fois l'identifiant obtenu.
    expect(dev.status.count('protectedDataChange')).toBe(0);
    expect(dev.app.count('appStateChange')).toBe(0);
  });

  it('marqueur local absent ET Keychain verrouillé : AUCUNE purge (choix biométriques conservés)', async () => {
    const dev = fakeDevice({ probe: true });
    dev.store.set(KEY, ID);
    dev.store.set(`${SECURE_PREFIX}${SECURE_KEYS.biometricsState}`, '{"v":1,"users":{}}');
    dev.st.locked = true;
    expect(await initInstallationId()).toBeNull();
    expect(dev.secure.internalClearItemsWithPrefix).not.toHaveBeenCalled();
    expect(ls.getItem(INSTALL_MARKER_KEY)).toBeNull();
    expect(dev.store.get(KEY)).toBe(ID);
  });

  it('binaire antérieur (sans sonde), app en arrière-plan : report ; retour au premier plan → même identifiant', async () => {
    const dev = fakeDevice({ probe: false });
    dev.store.set(KEY, ID);
    ls.setItem(INSTALL_MARKER_KEY, '1');
    dev.st.locked = true;
    dev.st.active = false;
    expect(await initInstallationId()).toBeNull();
    expect(dev.secure.internalSetItem).not.toHaveBeenCalled();

    dev.st.locked = false;
    dev.st.active = true;
    dev.app.emit('appStateChange', { isActive: true });
    await flush();
    expect(await initInstallationId()).toBe(ID);
    expect(dev.secure.internalSetItem).not.toHaveBeenCalled();
  });

  it('Android, Keystore en erreur passagère : report puis relance différée, même identifiant', async () => {
    vi.useFakeTimers();
    const dev = fakeDevice({ platform: 'android' });
    dev.store.set(KEY, ID);
    ls.setItem(INSTALL_MARKER_KEY, '1');
    dev.st.throws = true;
    expect(await initInstallationId()).toBeNull();
    dev.st.throws = false;
    await vi.advanceTimersByTimeAsync(INSTALLATION_RETRY_AFTER_ERROR_MS);
    expect(await initInstallationId()).toBe(ID);
    expect(dev.secure.internalSetItem).not.toHaveBeenCalled();
  });

  it('binaire antérieur au premier plan, vraiment absent : création après confirmation, une seule fois', async () => {
    vi.useFakeTimers();
    const dev = fakeDevice({ probe: false });
    ls.setItem(INSTALL_MARKER_KEY, '1');
    const a = initInstallationId();
    const b = initInstallationId(); // appel concurrent : même promesse
    await vi.advanceTimersByTimeAsync(INSTALLATION_CONFIRM_REREAD_MS);
    const [ia, ib] = await Promise.all([a, b]);
    expect(ia).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(ib).toBe(ia);
    expect(dev.secure.internalSetItem).toHaveBeenCalledTimes(1);
    expect(dev.store.get(KEY)).toBe(ia);
  });

  it('réinstallation au premier plan (AUTH-13) : purge puis nouvel identifiant (comportement lot 95 conservé)', async () => {
    const dev = fakeDevice({ probe: true });
    dev.store.set(KEY, ID);
    const id = await initInstallationId();
    expect(id).not.toBe(ID);
    expect(dev.secure.internalClearItemsWithPrefix).toHaveBeenCalledTimes(1);
    expect(ls.getItem(INSTALL_MARKER_KEY)).toBe('1');
  });

  it('journal technique : codes seulement, jamais la valeur de l’identifiant', async () => {
    const dev = fakeDevice({ probe: true });
    dev.store.set(KEY, ID);
    ls.setItem(INSTALL_MARKER_KEY, '1');
    dev.st.locked = true;
    await initInstallationId();
    dev.st.locked = false;
    dev.status.emit('protectedDataChange', { available: true });
    await flush();
    await initInstallationId();
    const entries = readUnlockJournal().filter((e) => e.c === 'INSTALL_ID');
    expect(entries.map((e) => e.d.outcome)).toEqual(['deferred', 'loaded']);
    expect(entries[0].d).toMatchObject({ reason: 'locked', osStatus: -25308, protectedData: false, platform: 'ios' });
    expect(ls.getItem(UNLOCK_JOURNAL_KEY)).not.toContain(ID);
  });
});
