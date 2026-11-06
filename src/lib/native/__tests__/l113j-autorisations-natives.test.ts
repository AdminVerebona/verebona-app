/**
 * Lot 113J — biométrie et notifications : demande NATIVE seule (décision PO du
 * 06/11/2026 « une seule décision par autorisation »). Remplace les fenêtres
 * Verebona de proposition (107A / 109G / 111G / 111T). Pont natif SIMULÉ.
 *
 *   L113J-SEQ    séquencement : biométrie native PUIS notifications natives,
 *                jamais deux demandes en même temps, pause entre les deux ;
 *   L113J-ETAT   état réel lu avant toute sollicitation (indisponible, non
 *                enrôlée, bloquée, déjà active / décidée ; push accordé,
 *                refusé, déjà décidé) ;
 *   L113J-UNIQ   pas de double déclenchement (appels répétés, comptes A / B,
 *                lecture interrompue, verrou), refus / annulation sans boucle,
 *                note impossible = pas de demande ;
 *   L113J-REEL   modules réels (stockage sécurisé, plugin biométrique,
 *                Firebase Messaging simulés) iOS et Android : activation
 *                seulement après réussite, rien au lancement suivant ;
 *   L113J-REGL   Mon compte : Face ID bloqué dans les réglages → bouton vers
 *                les réglages (jamais ouvert automatiquement), resynchronisation
 *                au retour au premier plan ;
 *   L113J-SRC    aucune fenêtre ni toast Verebona de proposition, fichiers
 *                supprimés, verrou 111D et identifiant 112E non touchés,
 *                aucun code natif modifié.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NATIVE_PROMPT_GAP_MS, PERMISSION_READ_TIMEOUT_MS, createNativePermissions, nativePermissionsScreenAllowed,
  type NativePermissionsContext, type NativePermissionsDeps,
} from '@/lib/native/native-permissions-flow';
import {
  biometryBlockedBySettings, readBiometricSetting,
  type BiometricSetting, type BiometricState, type BiometricsChange,
} from '@/lib/native/biometric-consent';
import { biometricsStatusText } from '@/components/account/security/BiometricsBlock';
import { readPushOnboarding, type PushOnboardingRecord, type PushOnboardingStored } from '@/lib/native/push-onboarding';
import { canOpenNativeAppSettings, openNativeAppSettings, type NativePushRequest, type NativePushState } from '@/lib/native/push';
import { SECURE_KEYS, SECURE_PREFIX } from '@/lib/native/secure-store';
import { __resetShellInfoForTests, initInstallationId } from '@/lib/native/shell-info';

const ROOT = resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function deferred<T>() {
  let res!: (v: T) => void;
  let rej!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { res = a; rej = b; });
  return { promise, resolve: res, reject: rej };
}

function setting(state: BiometricState, o: Partial<BiometricSetting> = {}): BiometricSetting {
  return {
    supported: true, available: state !== 'unavailable', deviceSecure: true, state, stored: state === 'unavailable' || state === 'never' ? 'never' : state,
    enabled: state === 'active', label: 'Face ID', shortLabel: 'Face ID', type: 2, blockedBySettings: false, ...o,
  };
}

const ctx = (o: Partial<NativePermissionsContext> = {}): NativePermissionsContext => ({
  userId: 1, biometricsOn: true, pushOn: true, pathname: '/accueil', legalRequired: false, blocked: false, offline: false, ...o,
});

/**
 * Doubles contrôlés : chaque demande native reste ouverte tant que le test ne
 * répond pas ; `log` garde l'ordre exact des appels ; `open` compte les
 * demandes natives simultanées.
 */
function harness(o: {
  bio?: BiometricState | BiometricSetting | (() => Promise<BiometricSetting>);
  permission?: NativePushState;
  pushRecords?: Record<number, PushOnboardingRecord>;
  markBio?: boolean;
  markPush?: boolean;
} = {}) {
  const log: string[] = [];
  let open = 0;
  let maxOpen = 0;
  const bioPrompts: Array<ReturnType<typeof deferred<BiometricsChange>>> = [];
  const pushPrompts: Array<ReturnType<typeof deferred<NativePushRequest>>> = [];
  const timers: Array<{ ms: number; fire: () => void }> = [];
  const pushRecords: Record<number, PushOnboardingRecord> = { ...(o.pushRecords ?? {}) };
  const bioState: Record<number, BiometricState> = {};
  const deps = {
    ready: vi.fn(async () => 'inst'),
    readBiometrics: vi.fn(async (u: number) => {
      log.push(`bio.read:${u}`);
      if (typeof o.bio === 'function') return o.bio();
      if (o.bio && typeof o.bio === 'object') return o.bio;
      return setting(bioState[u] ?? (o.bio as BiometricState | undefined) ?? 'never');
    }),
    markBiometricsOffered: vi.fn(async (u: number) => {
      log.push(`bio.mark:${u}`);
      if (o.markBio === false) return false;
      bioState[u] = 'deferred';
      return true;
    }),
    activateBiometrics: vi.fn((u: number) => {
      log.push(`bio.prompt:${u}`);
      open++; maxOpen = Math.max(maxOpen, open);
      const d = deferred<BiometricsChange>();
      bioPrompts.push(d);
      return d.promise.then((r) => { open--; log.push(`bio.end:${u}:${r}`); if (r === 'enabled') bioState[u] = 'active'; return r; },
        (e) => { open--; log.push(`bio.end:${u}:error`); throw e; });
    }),
    recordBiometricsRefused: vi.fn(async (u: number) => { log.push(`bio.refused:${u}`); }),
    pushPermission: vi.fn(async () => { log.push('push.permission'); return o.permission ?? 'prompt'; }),
    readPushDecision: vi.fn(async (u: number) => pushRecords[u] ?? null),
    recordPushDecision: vi.fn(async (u: number, s: PushOnboardingStored, r?: NativePushState) => {
      log.push(`push.record:${u}:${s}${r ? `:${r}` : ''}`);
      if (s === 'offered' && o.markPush === false) return false;
      pushRecords[u] = { s, at: 'now', ...(r ? { r } : {}) };
      return true;
    }),
    requestPush: vi.fn(() => {
      log.push('push.prompt');
      open++; maxOpen = Math.max(maxOpen, open);
      const d = deferred<NativePushRequest>();
      pushPrompts.push(d);
      return d.promise.then((r) => { open--; log.push(`push.end:${r.state}`); return r; });
    }),
    delay: vi.fn((ms: number) => new Promise<void>((r) => { timers.push({ ms, fire: r }); })),
  } satisfies NativePermissionsDeps;
  const ctl = createNativePermissions(deps);
  return {
    ctl, deps, log, pushRecords, bioState,
    get maxOpen() { return maxOpen; },
    sync: async (c: Partial<NativePermissionsContext> = {}) => { ctl.sync(ctx(c)); await tick(); },
    answerBio: async (r: BiometricsChange, i = bioPrompts.length - 1) => { bioPrompts[i].resolve(r); await tick(); },
    failBio: async () => { bioPrompts[bioPrompts.length - 1].reject(new Error('plugin')); await tick(); },
    answerPush: async (r: NativePushRequest) => { pushPrompts[pushPrompts.length - 1].resolve(r); await tick(); },
    fire: async (ms: number) => { const due = timers.filter((t) => t.ms === ms); for (const t of due) { timers.splice(timers.indexOf(t), 1); t.fire(); } await tick(); },
    snap: () => ctl.getSnapshot(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  __resetShellInfoForTests();
});

// ── L113J-SEQ ───────────────────────────────────────────────────────────────

describe('L113J-SEQ — biométrie native puis notifications natives, jamais simultanées', () => {
  it('première connexion : « proposé » noté puis parcours natif ; notifications seulement après sa fin et une pause', async () => {
    const h = harness();
    await h.sync();
    expect(h.log).toEqual(['bio.read:1', 'bio.mark:1', 'bio.prompt:1']);
    expect(h.snap().active).toEqual({ userId: 1, step: 'bio', phase: 'prompting' });
    // Navigation, retour au premier plan… pendant la demande native : rien d'autre.
    for (const p of ['/documents', '/accueil', '/agenda']) await h.sync({ pathname: p });
    expect(h.deps.pushPermission).not.toHaveBeenCalled();
    await h.answerBio('enabled');
    expect(h.snap().active?.phase).toBe('gap'); // fenêtre système en cours de fermeture
    expect(h.deps.pushPermission).not.toHaveBeenCalled();
    await h.fire(NATIVE_PROMPT_GAP_MS);
    expect(h.log.slice(4)).toEqual(['push.permission', 'push.record:1:offered', 'push.prompt']);
    await h.answerPush({ state: 'granted', registered: true });
    expect(h.log.slice(-2)).toEqual(['push.end:granted', 'push.record:1:answered:granted']);
    expect(h.snap().outcomes[1]).toEqual({ bio: 'enabled', push: 'granted' });
    expect(h.snap().active).toBeNull();
    expect(h.maxOpen).toBe(1);
  });

  it('« actif » seulement après la réussite : échec, annulation, refus système → non activé, noté refusé', async () => {
    for (const r of ['refused', 'unavailable'] as const) {
      const h = harness();
      await h.sync();
      await h.answerBio(r);
      expect(h.bioState[1], r).toBe('deferred');
      expect(h.deps.recordBiometricsRefused).toHaveBeenCalledWith(1);
      expect(h.snap().outcomes[1]?.bio).toBe('not_enabled');
      await h.fire(NATIVE_PROMPT_GAP_MS);
      expect(h.deps.requestPush).toHaveBeenCalledTimes(1); // l'utilisateur poursuit : notifications ensuite
    }
    const err = harness();
    await err.sync();
    await err.failBio();
    expect(err.snap().outcomes[1]?.bio).toBe('not_enabled');
    const st = harness();
    await st.sync();
    await st.answerBio('storage_error');
    expect(st.snap().outcomes[1]?.bio).toBe('storage_error');
    expect(st.deps.recordBiometricsRefused).not.toHaveBeenCalled();
  });

  it('notifications refusées ou ignorées : réponse notée, aucune relance', async () => {
    const h = harness({ bio: 'unavailable' });
    await h.sync();
    await h.answerPush({ state: 'denied', registered: false });
    expect(h.pushRecords[1]).toMatchObject({ s: 'answered', r: 'denied' });
    expect(h.snap().outcomes[1]?.push).toBe('not_granted');
    for (let i = 0; i < 5; i++) await h.sync();
    expect(h.deps.requestPush).toHaveBeenCalledTimes(1);
  });

  it('accord sans jeton enregistré : issue distincte (jamais « activé » à tort)', async () => {
    const h = harness({ bio: 'active' });
    await h.sync();
    await h.answerPush({ state: 'granted', registered: false });
    expect(h.snap().outcomes[1]?.push).toBe('granted_unregistered');
  });
});

// ── L113J-ETAT ──────────────────────────────────────────────────────────────

describe('L113J-ETAT — état réel lu avant toute sollicitation', () => {
  it('biométrie indisponible, non enrôlée, bloquée, déjà active / décidée / à réactiver : aucune demande biométrique, push directement (sans pause)', async () => {
    const cases: Array<BiometricState | BiometricSetting> = [
      'unavailable', 'deferred', 'active', 'reactivate',
      setting('unavailable', { blockedBySettings: true }),
      setting('never', { supported: false, available: false }),
    ];
    for (const c of cases) {
      const h = harness({ bio: c });
      await h.sync();
      expect(h.deps.markBiometricsOffered, JSON.stringify(c)).not.toHaveBeenCalled();
      expect(h.deps.activateBiometrics).not.toHaveBeenCalled();
      expect(h.deps.delay.mock.calls.map(([ms]) => ms)).not.toContain(NATIVE_PROMPT_GAP_MS);
      expect(h.deps.requestPush).toHaveBeenCalledTimes(1);
      expect(h.snap().outcomes[1]?.bio).toBe('not_applicable');
    }
  });

  it('fonction biométrie coupée par le serveur : rien n’est lu, push directement', async () => {
    const h = harness();
    await h.sync({ biometricsOn: false });
    expect(h.deps.readBiometrics).not.toHaveBeenCalled();
    expect(h.deps.requestPush).toHaveBeenCalledTimes(1);
  });

  it('push déjà accordé : aucune demande (jeton enregistré par syncNativePush) ; refusé / indisponible : rien', async () => {
    for (const [permission, out] of [['granted', 'already_granted'], ['denied', 'not_applicable'], ['unavailable', 'not_applicable']] as const) {
      const h = harness({ bio: 'active', permission });
      await h.sync();
      expect(h.deps.requestPush, permission).not.toHaveBeenCalled();
      expect(h.deps.recordPushDecision).not.toHaveBeenCalled();
      expect(h.snap().outcomes[1]?.push).toBe(out);
    }
    expect(read('src/components/native/NativeBridgeRuntime.tsx')).toMatch(/void syncNativePush\(\);/);
  });

  it('push déjà décidé sur cette installation (proposé, « Plus tard » antérieur, répondu) : rien', async () => {
    for (const s of ['offered', 'later', 'answered'] as const) {
      const h = harness({ bio: 'active', pushRecords: { 1: { s, at: 'x' } } });
      await h.sync();
      expect(h.deps.requestPush, s).not.toHaveBeenCalled();
    }
  });

  it('fonction push coupée : rien', async () => {
    const h = harness({ bio: 'active' });
    await h.sync({ pushOn: false });
    expect(h.deps.pushPermission).not.toHaveBeenCalled();
    expect(h.snap().outcomes[1]?.push).toBe('feature_off');
  });
});

// ── L113J-UNIQ ──────────────────────────────────────────────────────────────

describe('L113J-UNIQ — pas de double déclenchement, pas de boucle', () => {
  it('jamais avant l’authentification, sur la connexion, les CGUV, sous le verrou ou la mise à jour obligatoire', async () => {
    const h = harness();
    for (const o of [{ userId: null }, { pathname: '/login' }, { pathname: '/signup' }, { pathname: '/cguv' }, { pathname: null }, { legalRequired: true }, { blocked: true }]) {
      await h.sync(o);
      expect(nativePermissionsScreenAllowed(ctx(o)), JSON.stringify(o)).toBe(false);
    }
    expect(h.log).toEqual([]);
    await h.sync();
    expect(h.deps.activateBiometrics).toHaveBeenCalledTimes(1);
  });

  it('hors ligne : la biométrie peut se faire, les notifications attendent le réseau', async () => {
    const h = harness({ bio: 'active' });
    await h.sync({ offline: true });
    expect(h.deps.readBiometrics).toHaveBeenCalledTimes(1);
    expect(h.deps.pushPermission).not.toHaveBeenCalled();
    await h.sync({ offline: true });
    expect(h.deps.pushPermission).not.toHaveBeenCalled();
    await h.sync();
    expect(h.deps.requestPush).toHaveBeenCalledTimes(1);
  });

  it('appels répétés (rendus, retours au premier plan) : chaque lecture et chaque demande une seule fois', async () => {
    const h = harness();
    h.ctl.sync(ctx()); h.ctl.sync(ctx()); h.ctl.sync(ctx());
    await h.sync(); await h.sync();
    expect(h.deps.readBiometrics).toHaveBeenCalledTimes(1);
    expect(h.deps.activateBiometrics).toHaveBeenCalledTimes(1);
    await h.answerBio('refused');
    await h.fire(NATIVE_PROMPT_GAP_MS);
    for (let i = 0; i < 4; i++) await h.sync();
    await h.answerPush({ state: 'prompt', registered: false });
    for (let i = 0; i < 4; i++) await h.sync();
    expect(h.deps.activateBiometrics).toHaveBeenCalledTimes(1);
    expect(h.deps.requestPush).toHaveBeenCalledTimes(1);
    expect(h.maxOpen).toBe(1);
  });

  it('lancement suivant (nouveau contrôleur, mêmes mémorisations) : rien n’est redemandé, accordé ou refusé', async () => {
    for (const [bio, push] of [['enabled', 'granted'], ['refused', 'denied']] as const) {
      const first = harness();
      await first.sync();
      await first.answerBio(bio);
      await first.fire(NATIVE_PROMPT_GAP_MS);
      await first.answerPush({ state: push, registered: push === 'granted' });
      // Relance : mêmes états lus (biométrie active / reportée, push accordé / décidé).
      const next = harness({ bio: first.bioState[1], permission: push, pushRecords: first.pushRecords });
      await next.sync();
      await next.sync({ pathname: '/documents' });
      expect(next.deps.activateBiometrics, bio).not.toHaveBeenCalled();
      expect(next.deps.requestPush, push).not.toHaveBeenCalled();
    }
  });

  it('app fermée PENDANT la demande native : déjà notée, jamais relancée au lancement suivant', async () => {
    const h = harness();
    await h.sync();
    expect(h.bioState[1]).toBe('deferred'); // « proposé » posé avant la fenêtre système
    const next = harness({ bio: h.bioState[1] });
    await next.sync();
    expect(next.deps.activateBiometrics).not.toHaveBeenCalled();
  });

  it('note impossible (stockage en échec) : aucune demande native (sinon elle reviendrait à chaque lancement)', async () => {
    const h = harness({ markBio: false, markPush: false });
    await h.sync();
    expect(h.deps.activateBiometrics).not.toHaveBeenCalled();
    expect(h.snap().outcomes[1]?.bio).toBe('mark_failed');
    expect(h.deps.requestPush).not.toHaveBeenCalled();
    expect(h.snap().outcomes[1]?.push).toBe('mark_failed');
  });

  it('compte changé ou verrou PENDANT la lecture : rien de noté, réévalué ensuite', async () => {
    const pending = deferred<BiometricSetting>();
    const h = harness({ bio: () => pending.promise });
    await h.sync({ userId: 1 });
    await h.sync({ userId: 2 }); // ignoré : une étape est déjà en cours
    pending.resolve(setting('never'));
    await tick();
    expect(h.deps.markBiometricsOffered).not.toHaveBeenCalledWith(1);
    expect(h.snap().bio[1]).toBeUndefined();
    // Le compte 2 (courant) est traité ensuite.
    expect(h.deps.readBiometrics).toHaveBeenLastCalledWith(2, true);

    const lock = deferred<BiometricSetting>();
    const k = harness({ bio: () => lock.promise });
    await k.sync();
    await k.sync({ blocked: true }); // verrou affiché pendant la lecture
    lock.resolve(setting('never'));
    await tick();
    expect(k.deps.activateBiometrics).not.toHaveBeenCalled();
    await k.sync(); // déverrouillé : réévaluée
    expect(k.deps.readBiometrics).toHaveBeenCalledTimes(2);
  });

  it('compte A puis compte B sur le même téléphone : chacun sa décision, jamais deux demandes simultanées', async () => {
    const h = harness();
    await h.sync({ userId: 1 });
    await h.sync({ userId: 2 }); // pendant la demande de A : rien pour B
    expect(h.deps.activateBiometrics).toHaveBeenCalledTimes(1);
    await h.answerBio('enabled');
    await h.fire(NATIVE_PROMPT_GAP_MS);
    // Contexte courant = B : B a sa propre étape biométrique (A reprendra ses notifications à son retour).
    expect(h.deps.activateBiometrics).toHaveBeenLastCalledWith(2);
    expect(h.maxOpen).toBe(1);
  });

  it('lecture trop longue : étape abandonnée sans rien noter, notifications non bloquées', async () => {
    const h = harness({ bio: () => new Promise(() => {}) });
    await h.sync();
    await h.fire(PERMISSION_READ_TIMEOUT_MS);
    expect(h.snap().outcomes[1]?.bio).toBe('read_failed');
    expect(h.deps.markBiometricsOffered).not.toHaveBeenCalled();
    expect(h.deps.pushPermission).toHaveBeenCalled();
  });
});

// ── L113J-REEL ──────────────────────────────────────────────────────────────

function fakeSecureStorage() {
  const store = new Map<string, string>();
  return {
    store,
    internalGetItem: vi.fn(async ({ prefixedKey }: { prefixedKey: string }) => ({ data: store.get(prefixedKey) ?? null })),
    internalSetItem: vi.fn(async ({ prefixedKey, data }: { prefixedKey: string; data: string }) => { store.set(prefixedKey, data); }),
    internalRemoveItem: vi.fn(async ({ prefixedKey }: { prefixedKey: string }) => ({ success: store.delete(prefixedKey) })),
    internalClearItemsWithPrefix: vi.fn(async ({ prefix }: { prefix: string }) => {
      for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
    }),
  };
}

function fakeLocalStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); } };
}

function installNative(plugins: Record<string, unknown>, platform: 'ios' | 'android', ls = fakeLocalStorage()) {
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => platform, Plugins: plugins },
    location: { protocol: 'https:', origin: 'https://app.preprod.verebona.fr', pathname: '/accueil', search: '' },
  }));
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone) VerebonaApp/1.0', standalone: false });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  return ls;
}

/** Plugins simulés ; `events` garde l'ordre des fenêtres système (ouverture / fermeture). */
function devicePlugins(o: { authError?: string; push?: NativePushState; check?: { isAvailable: boolean; biometryType: number; code?: string } } = {}) {
  const events: string[] = [];
  let receive: string = 'prompt';
  const bio = {
    checkBiometry: vi.fn(async () => ({ isAvailable: true, deviceIsSecure: true, biometryType: 2, code: '', ...o.check })),
    internalAuthenticate: vi.fn(async () => {
      events.push('bio:open');
      await new Promise((r) => setTimeout(r, 5));
      events.push('bio:close');
      if (o.authError) throw Object.assign(new Error(o.authError), { code: o.authError });
    }),
  };
  const messaging = {
    checkPermissions: vi.fn(async () => ({ receive })),
    requestPermissions: vi.fn(async () => {
      events.push('push:open');
      await new Promise((r) => setTimeout(r, 5));
      events.push('push:close');
      receive = o.push ?? 'granted';
      return { receive };
    }),
    getToken: vi.fn(async () => ({ token: 'fcm-1' })),
    deleteToken: vi.fn(async () => {}),
  };
  return { events, bio, messaging, sec: fakeSecureStorage() };
}

async function runToEnd(ctl: ReturnType<typeof createNativePermissions>, userId = 1) {
  // Comme NativeBridgeRuntime : identifiant d'installation initialisé au démarrage (AUTH-13).
  await initInstallationId();
  const c = ctx({ userId });
  for (let i = 0; i < 200 && ctl.getSnapshot().push[userId] !== 'done'; i++) {
    ctl.sync(c);
    await new Promise((r) => setTimeout(r, 10));
  }
  return ctl.getSnapshot().outcomes[userId];
}

describe('L113J-REEL — modules réels, iOS et Android', () => {
  for (const platform of ['ios', 'android'] as const) {
    it(`${platform} : biométrie native réussie → active, PUIS notifications natives ; rien au lancement suivant`, async () => {
      const d = devicePlugins();
      const ls = installNative({ SecureStorage: d.sec, BiometricAuthNative: d.bio, FirebaseMessaging: d.messaging }, platform);
      expect(await runToEnd(createNativePermissions())).toEqual({ bio: 'enabled', push: 'granted' });
      // Ordre et absence de chevauchement des fenêtres système.
      expect(d.events).toEqual(['bio:open', 'bio:close', 'push:open', 'push:close']);
      // Vérification biométrique SEULE (pas de code du téléphone) pour activer.
      expect(d.bio.internalAuthenticate).toHaveBeenCalledWith(expect.objectContaining({ allowDeviceCredential: false }));
      expect((await readBiometricSetting(platform, 1)).state).toBe('active');
      expect(await readPushOnboarding(1)).toMatchObject({ s: 'answered', r: 'granted' });
      // Relance de l'app (même installation) : aucune demande.
      __resetShellInfoForTests();
      installNative({ SecureStorage: d.sec, BiometricAuthNative: d.bio, FirebaseMessaging: d.messaging }, platform, ls);
      expect(await runToEnd(createNativePermissions())).toEqual({ bio: 'not_applicable', push: 'already_granted' });
      expect(d.bio.internalAuthenticate).toHaveBeenCalledTimes(1);
      expect(d.messaging.requestPermissions).toHaveBeenCalledTimes(1);
    });
  }

  it('iOS : Face ID refusé dans la demande du système (ou annulé) → non activé, jamais redemandé', async () => {
    for (const err of ['biometryNotAvailable', 'userCancel', 'authenticationFailed', 'systemCancel']) {
      __resetShellInfoForTests();
      const d = devicePlugins({ authError: err, push: 'denied' });
      const ls = installNative({ SecureStorage: d.sec, BiometricAuthNative: d.bio, FirebaseMessaging: d.messaging }, 'ios');
      expect(await runToEnd(createNativePermissions()), err).toEqual({ bio: 'not_enabled', push: 'not_granted' });
      const raw = JSON.parse(d.sec.store.get(`${SECURE_PREFIX}${SECURE_KEYS.biometricsState}`)!);
      expect(raw.users['1']).toMatchObject({ s: 'deferred', why: 'refused' });
      __resetShellInfoForTests();
      installNative({ SecureStorage: d.sec, BiometricAuthNative: d.bio, FirebaseMessaging: d.messaging }, 'ios', ls);
      await runToEnd(createNativePermissions());
      expect(d.bio.internalAuthenticate).toHaveBeenCalledTimes(1);
      expect(d.messaging.requestPermissions).toHaveBeenCalledTimes(1);
    }
  });

  it('téléphone sans biométrie configurée : aucune demande biométrique, connexion habituelle, notifications seules', async () => {
    const d = devicePlugins({ check: { isAvailable: false, biometryType: 0, code: 'biometryNotEnrolled' } });
    installNative({ SecureStorage: d.sec, BiometricAuthNative: d.bio, FirebaseMessaging: d.messaging }, 'android');
    expect(await runToEnd(createNativePermissions())).toEqual({ bio: 'not_applicable', push: 'granted' });
    expect(d.bio.internalAuthenticate).not.toHaveBeenCalled();
    expect(d.events).toEqual(['push:open', 'push:close']);
  });
});

// ── L113J-REGL ──────────────────────────────────────────────────────────────

describe('L113J-REGL — Mon compte : état système réel, accès aux réglages, resynchronisation', () => {
  it('Face ID bloqué dans les réglages : iOS seulement, distinct de « non configuré »', () => {
    expect(biometryBlockedBySettings('ios', { available: false, type: 2, code: 'biometryNotAvailable' })).toBe(true);
    expect(biometryBlockedBySettings('ios', { available: false, type: 2, code: 'biometryNotEnrolled' })).toBe(false);
    expect(biometryBlockedBySettings('ios', { available: false, type: 1, code: 'biometryNotAvailable' })).toBe(false); // Touch ID : pas d'autorisation par app
    expect(biometryBlockedBySettings('ios', { available: true, type: 2, code: null })).toBe(false);
    expect(biometryBlockedBySettings('android', { available: false, type: 4, code: 'biometryNotAvailable' })).toBe(false);
  });

  it('lecture réelle : code du plugin transmis, texte et bouton dédiés', async () => {
    const d = devicePlugins({ check: { isAvailable: false, biometryType: 2, code: 'biometryNotAvailable' } });
    installNative({ SecureStorage: d.sec, BiometricAuthNative: d.bio }, 'ios');
    const s = await readBiometricSetting('ios', 1);
    expect(s).toMatchObject({ available: false, blockedBySettings: true, state: 'unavailable' });
    expect(biometricsStatusText(s, true)).toBe('Face ID est bloqué pour Verebona sur ce téléphone. Pour l’utiliser : ouvrez Réglages › Verebona, puis activez « Face ID ».');
    // Débloqué dans les réglages puis retour : état relu.
    d.bio.checkBiometry.mockResolvedValueOnce({ isAvailable: true, deviceIsSecure: true, biometryType: 2, code: '' });
    expect(await readBiometricSetting('ios', 1)).toMatchObject({ available: true, blockedBySettings: false, state: 'never' });
  });

  it('réglages ouverts uniquement sur action (iOS, AppLauncher) ; jamais automatiquement', async () => {
    const launcher = { openUrl: vi.fn(async () => ({ completed: true })) };
    installNative({ AppLauncher: launcher }, 'ios');
    expect(canOpenNativeAppSettings()).toBe(true);
    expect(await openNativeAppSettings()).toBe(true);
    expect(launcher.openUrl).toHaveBeenCalledWith({ url: 'app-settings:' });
    installNative({ AppLauncher: launcher }, 'android');
    expect(canOpenNativeAppSettings()).toBe(false);
    for (const f of ['src/components/account/security/BiometricsBlock.tsx', 'src/components/native/NativePushDeviceSettings.tsx']) {
      const src = read(f);
      // Seul appel : dans le gestionnaire du bouton « Ouvrir les réglages ».
      const calls = src.match(/open(NativeAppSettings|NativeNotificationSettings)\(\)/g) ?? [];
      expect(calls.length, f).toBe(1);
      expect(src, f).toMatch(/onClick=\{\(\) => \{ void ouvrirReglages\(\); \}\}>Ouvrir les réglages</);
    }
    expect(read('src/lib/native/native-permissions-flow.ts')).not.toMatch(/openNative|AppLauncher|app-settings/);
  });

  it('état affiché resynchronisé au retour au premier plan (Sécurité et Notifications)', () => {
    const bio = read('src/components/account/security/BiometricsBlock.tsx');
    expect(bio).toMatch(/'appStateChange', \(st\) => \{\s*if \(st\.isActive\) void reload\(\);/);
    expect(bio).toMatch(/addEventListener\('visibilitychange'/);
    expect(bio).toMatch(/setting\.blockedBySettings && featureOn && canOpenNativeAppSettings\(\)/);
    const push = read('src/components/native/NativePushDeviceSettings.tsx');
    expect(push).toMatch(/'appStateChange', \(s\) => \{\s*if \(s\.isActive\) void relire\(\)/);
    expect(push).toMatch(/status\.kind === 'denied' && canOpenNativeNotificationSettings\(\)/);
  });
});

// ── L113J-SRC ───────────────────────────────────────────────────────────────

describe('L113J-SRC — aucune fenêtre ni toast Verebona de proposition', () => {
  it('fenêtres et orchestration supprimées, non recréées', () => {
    for (const f of [
      'src/components/native/NativeOfferDialog.tsx', 'src/components/native/BiometricOfferCard.tsx',
      'src/components/native/PushOnboardingCard.tsx', 'src/components/native/BiometricGlyph.tsx',
      'src/components/native/useBiometricOffer.ts', 'src/components/native/usePushOnboarding.ts',
      'src/lib/native/biometric-offer-flow.ts', 'src/lib/native/biometric-offer-presentation.ts',
    ]) expect(existsSync(resolve(ROOT, f)), f).toBe(false);
    const runtime = read('src/components/native/NativeBridgeRuntime.tsx');
    expect(runtime).toMatch(/useNativePermissionsFlow\(features, blocked, offline\);/);
    expect(runtime).not.toMatch(/OfferCard|OnboardingCard|NativeOfferDialog|Activer Face ID|Autoriser les notifications/);
  });

  it('contrôleur et hook : aucun rendu, aucun toast, aucun texte de proposition', () => {
    for (const f of ['src/lib/native/native-permissions-flow.ts', 'src/components/native/useNativePermissionsFlow.ts']) {
      const code = read(f).split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      expect(code, f).not.toMatch(/sonner|toast|createElement|role=|Plus tard|Activer|Autoriser/);
    }
  });

  it('verrou 111D et identifiant d’installation 112E non touchés ; aucun code natif requis', () => {
    const flow = read('src/lib/native/native-permissions-flow.ts');
    expect(flow).not.toMatch(/unlock-|resolveUnlockBiometry/);
    // 112E : identifiant seulement attendu (appel public existant), jamais modifié.
    expect(flow).toMatch(/ready: initInstallationId/);
    // Seuls des plugins déjà présents dans les binaires (BiometricAuthNative, FirebaseMessaging, SecureStorage, AppLauncher).
    expect(read('mobile/package.json')).toMatch(/"@aparajita\/capacitor-biometric-auth"/);
    expect(read('mobile/package.json')).toMatch(/"@capacitor-firebase\/messaging"/);
    expect(read('mobile/ios/App/App/Info.plist')).toMatch(/<key>NSFaceIDUsageDescription<\/key>/);
  });
});
