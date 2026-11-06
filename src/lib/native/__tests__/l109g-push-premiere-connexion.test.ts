/**
 * Lot 109G — invitation « Autoriser les notifications » à la première
 * connexion mobile. Pont natif SIMULÉ (Firebase Messaging, stockage sécurisé,
 * AppLauncher) ; le Web reste inchangé.
 *
 *   L109G-TXT   textes conservés (Mon compte), messages de réactivation iOS / Android ;
 *   L109G-RULE  décision (permission × décision enregistrée), écrans utilisables ;
 *   (L109G-FLOW supprimé au lot 113J — décision PO du 06/11/2026 : plus de
 *               fenêtre « Autoriser les notifications ? », demande NATIVE
 *               directe après la biométrie ; parcours couvert par
 *               l113j-autorisations-natives.test.ts) ;
 *   L109G-STORE persistance par compte × installation, ancienne clé globale ;
 *   L109G-NATIVE socle push réel : une seule demande système, jeton enregistré,
 *               pas de faux « activé », réglages iOS ;
 *   L109G-SRC   branchements (runtime, Mon compte) et binaires inchangés.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LEGACY_PUSH_PROMPT_DISMISSED_KEY, PUSH_ONBOARDING_ALLOW, PUSH_ONBOARDING_LOCAL_KEY,
  clearLegacyPushPromptKey, devicePushStatusText,
  parsePushOnboardingDoc, pushOnboardingDecision, pushOnboardingScreenAllowed, pushReenableHelp,
  pushRequestOutcomeMessage, readPushOnboarding, recordPushOnboarding,
} from '@/lib/native/push-onboarding';
import { createNativePermissions } from '@/lib/native/native-permissions-flow';
import {
  IOS_APP_SETTINGS_URL, canOpenNativeNotificationSettings, enableNativePush, openNativeNotificationSettings, requestNativePush,
} from '@/lib/native/push';
import { SECURE_KEYS, SECURE_PREFIX } from '@/lib/native/secure-store';
import { __resetShellInfoForTests } from '@/lib/native/shell-info';
import type { NativePushState } from '@/lib/native/push';

const ROOT = resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

// ── Doubles ─────────────────────────────────────────────────────────────────

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
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

function fakeMessaging(o: { check?: NativePushState | 'prompt-with-rationale'; answer?: NativePushState; token?: string } = {}) {
  let current: string = o.check ?? 'prompt';
  return {
    checkPermissions: vi.fn(async () => ({ receive: current })),
    requestPermissions: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5)); // fenêtre système
      current = o.answer ?? 'granted';
      return { receive: current };
    }),
    getToken: vi.fn(async () => ({ token: o.token ?? 'fcm-token-1' })),
    deleteToken: vi.fn(async () => {}),
  };
}

function installNative(plugins: Record<string, unknown>, platform: 'ios' | 'android' = 'ios', ls = fakeLocalStorage()) {
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => platform, Plugins: plugins },
    location: { protocol: 'https:', origin: 'https://app.preprod.verebona.fr', pathname: '/accueil', search: '' },
  }));
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone) VerebonaApp/1.0', standalone: false });
  return ls;
}

/** Lot 113J : contrôleur réel (biométrie absente du pont simulé → notifications directement). */
async function runRealFlow(userId: number) {
  const ctl = createNativePermissions();
  const c = { userId, biometricsOn: true, pushOn: true, pathname: '/accueil', legalRequired: false, blocked: false, offline: false };
  ctl.sync(c);
  for (let i = 0; i < 40 && (ctl.getSnapshot().push[userId] !== 'done'); i++) { await flush(); ctl.sync(c); }
  return ctl.getSnapshot().outcomes[userId]?.push;
}

afterEach(() => {
  vi.unstubAllGlobals();
  __resetShellInfoForTests();
});

// ── L109G-TXT ───────────────────────────────────────────────────────────────

describe('L109G-TXT — textes', () => {
  // Lot 113J (décision PO du 06/11/2026) : la fenêtre « Autoriser les
  // notifications ? » et ses textes (titre, texte, « Plus tard ») sont
  // supprimés ; seul le libellé du bouton de Mon compte › Notifications reste.
  it('libellé du bouton de Mon compte conservé ; textes de la fenêtre supprimés', async () => {
    expect(PUSH_ONBOARDING_ALLOW).toBe('Autoriser les notifications');
    const mod = await import('@/lib/native/push-onboarding') as Record<string, unknown>;
    for (const k of ['PUSH_ONBOARDING_TITLE', 'PUSH_ONBOARDING_TEXT', 'PUSH_ONBOARDING_LATER', 'createPushOnboarding', 'sharedPushOnboarding']) {
      expect(mod[k], k).toBeUndefined();
    }
  });

  it('réactivation adaptée au système', () => {
    expect(pushReenableHelp('ios')).toMatch(/Réglages › Verebona › Notifications/);
    expect(pushReenableHelp('android')).toMatch(/Paramètres › Applications › Verebona › Notifications/);
  });

  it('jamais « activé » sans jeton enregistré', () => {
    expect(pushRequestOutcomeMessage({ state: 'granted', registered: true }, 'ios').kind).toBe('success');
    const fail = pushRequestOutcomeMessage({ state: 'granted', registered: false }, 'ios');
    expect(fail.kind).toBe('error');
    expect(fail.text).not.toMatch(/^Notifications activées/);
    expect(pushRequestOutcomeMessage({ state: 'denied', registered: false }, 'android').text).toMatch(/Paramètres/);
    expect(pushRequestOutcomeMessage({ state: 'prompt', registered: false }, 'ios').kind).toBe('info');
    expect(devicePushStatusText({ kind: 'granted', registered: false }, 'ios')).toMatch(/n’a pas pu être enregistré/);
    expect(devicePushStatusText({ kind: 'denied' }, 'ios')).toMatch(/Réglages/);
  });
});

// ── L109G-RULE ──────────────────────────────────────────────────────────────

describe('L109G-RULE — décision et écrans', () => {
  it('invitation seulement si permission indéterminée ET jamais proposée sur cette installation', () => {
    expect(pushOnboardingDecision({ permission: 'prompt', record: null })).toBe('offer');
    for (const s of ['offered', 'later', 'answered'] as const) {
      expect(pushOnboardingDecision({ permission: 'prompt', record: { s, at: 'x' } })).toBe('none');
    }
    for (const p of ['granted', 'denied', 'unavailable'] as const) expect(pushOnboardingDecision({ permission: p, record: null })).toBe('none');
  });

  it('jamais sur connexion, inscription, activation, CGUV, verrou / écran bloquant, hors ligne', () => {
    for (const p of ['/login', '/signup', '/verify-email', '/connexion-sociale', '/forgot-password', '/cguv', '/compte-en-suppression', null]) {
      expect(pushOnboardingScreenAllowed({ pathname: p, legalRequired: false, blocked: false, offline: false }), String(p)).toBe(false);
    }
    expect(pushOnboardingScreenAllowed({ pathname: '/accueil', legalRequired: false, blocked: false, offline: false })).toBe(true);
    expect(pushOnboardingScreenAllowed({ pathname: '/accueil', legalRequired: true, blocked: false, offline: false })).toBe(false);
    expect(pushOnboardingScreenAllowed({ pathname: '/accueil', legalRequired: false, blocked: true, offline: false })).toBe(false);
    expect(pushOnboardingScreenAllowed({ pathname: '/accueil', legalRequired: false, blocked: false, offline: true })).toBe(false);
  });
});

// ── L109G-STORE ─────────────────────────────────────────────────────────────

describe('L109G-STORE — persistance par compte × installation', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });

  it('décision par compte, dans le stockage sécurisé, sans jeton ni secret', async () => {
    const sec = fakeSecureStorage();
    installNative({ SecureStorage: sec });
    expect(await readPushOnboarding(1)).toBeNull();
    expect(await recordPushOnboarding(1, 'later')).toBe(true);
    expect((await readPushOnboarding(1))?.s).toBe('later');
    expect(await readPushOnboarding(2)).toBeNull();
    const raw = sec.store.get(`${SECURE_PREFIX}${SECURE_KEYS.pushOnboarding}`)!;
    const doc = JSON.parse(raw);
    expect(doc.inst).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(Object.keys(doc.users)).toEqual(['1']);
    expect(raw).not.toMatch(/token/i);
  });

  it('écritures concurrentes : aucune décision perdue', async () => {
    installNative({ SecureStorage: fakeSecureStorage() });
    await Promise.all([recordPushOnboarding(1, 'offered'), recordPushOnboarding(2, 'offered'), recordPushOnboarding(1, 'later')]);
    expect((await readPushOnboarding(1))?.s).toBe('later');
    expect((await readPushOnboarding(2))?.s).toBe('offered');
  });

  it('réinstallation (stockage purgé, nouvel identifiant) : rien n’est hérité', async () => {
    const sec = fakeSecureStorage();
    installNative({ SecureStorage: sec });
    await recordPushOnboarding(1, 'later');
    // Nouvelle installation : marqueur local absent → purge du stockage sécurisé (AUTH-13).
    __resetShellInfoForTests();
    installNative({ SecureStorage: sec }, 'ios', fakeLocalStorage());
    expect(await readPushOnboarding(1)).toBeNull();
  });

  it('document d’une autre installation ignoré ; document abîmé toléré', () => {
    const raw = JSON.stringify({ v: 1, inst: 'A'.repeat(20), users: { 1: { s: 'later', at: 'x' }, x: { s: 'later' }, 2: { s: 'bogus' } } });
    expect(parsePushOnboardingDoc(raw, 'B'.repeat(20)).users).toEqual({});
    expect(Object.keys(parsePushOnboardingDoc(raw, 'A'.repeat(20)).users)).toEqual(['1']);
    expect(parsePushOnboardingDoc('{', 'A').users).toEqual({});
    expect(parsePushOnboardingDoc(null, 'A').users).toEqual({});
  });

  it('ancienne clé GLOBALE (lot 95) effacée et ignorée : comptes déjà connectés repris', async () => {
    const ls = installNative({ SecureStorage: fakeSecureStorage(), FirebaseMessaging: fakeMessaging() });
    ls.setItem(LEGACY_PUSH_PROMPT_DISMISSED_KEY, '1');
    clearLegacyPushPromptKey();
    expect(ls.getItem(LEGACY_PUSH_PROMPT_DISMISSED_KEY)).toBeNull();
    // Lot 113J : la demande native est faite (ancienne clé ignorée).
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    expect(await runRealFlow(7)).toBe('granted');
  });

  it('stockage sécurisé indisponible : repli local, toujours par compte', async () => {
    const ls = installNative({});
    expect(await recordPushOnboarding(3, 'later')).toBe(true);
    expect(ls.getItem(PUSH_ONBOARDING_LOCAL_KEY)).toContain('"3"');
    expect((await readPushOnboarding(3))?.s).toBe('later');
    expect(await readPushOnboarding(4)).toBeNull();
  });
});

// ── L109G-NATIVE ────────────────────────────────────────────────────────────

describe('L109G-NATIVE — socle push réel (lib/native/push)', () => {
  it('« Autoriser » : une seule fenêtre système, jeton enregistré pour CETTE installation', async () => {
    const m = fakeMessaging({ answer: 'granted', token: 'fcm-A' });
    installNative({ SecureStorage: fakeSecureStorage(), FirebaseMessaging: m });
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const [a, b, c] = await Promise.all([requestNativePush(), requestNativePush(), enableNativePush()]);
    expect(a).toEqual({ state: 'granted', registered: true });
    expect(b).toEqual(a);
    expect(c).toBe('granted');
    expect(m.requestPermissions).toHaveBeenCalledTimes(1);
    const posts = fetchSpy.mock.calls.filter((x) => (x as unknown as [string])[0] === '/api/mobile/push-installations');
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String((posts[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ platform: 'ios', pushToken: 'fcm-A' });
    expect(body.installationId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it('enregistrement en échec : autorisation accordée mais registered = false (pas de faux « activé »)', async () => {
    installNative({ SecureStorage: fakeSecureStorage(), FirebaseMessaging: fakeMessaging({ answer: 'granted' }) });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await requestNativePush()).toEqual({ state: 'granted', registered: false });
  });

  it('refus OS : aucun enregistrement, état « refusé »', async () => {
    const m = fakeMessaging({ answer: 'denied' });
    installNative({ SecureStorage: fakeSecureStorage(), FirebaseMessaging: m }, 'android');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await requestNativePush()).toEqual({ state: 'denied', registered: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(m.getToken).not.toHaveBeenCalled();
  });

  it('lot 113J — parcours complet avec le socle réel : demande NATIVE directe, réponse notée, rien au lancement suivant', async () => {
    const sec = fakeSecureStorage();
    const m = fakeMessaging({ check: 'prompt-with-rationale', answer: 'granted' }); // Android 13+ après un premier refus
    const ls = installNative({ SecureStorage: sec, FirebaseMessaging: m }, 'android');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    expect(await runRealFlow(1)).toBe('granted');
    expect(m.requestPermissions).toHaveBeenCalledTimes(1);
    expect((await readPushOnboarding(1))).toMatchObject({ s: 'answered', r: 'granted' });
    // Lancement suivant (même installation) : autorisation accordée → aucune demande.
    __resetShellInfoForTests();
    installNative({ SecureStorage: sec, FirebaseMessaging: m }, 'android', ls);
    expect(await runRealFlow(1)).toBe('already_granted');
    expect(m.requestPermissions).toHaveBeenCalledTimes(1);
  });

  it('Web : aucune demande', async () => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { origin: 'https://app.verebona.fr' } }));
    expect(await requestNativePush()).toEqual({ state: 'unavailable', registered: false });
    expect(await runRealFlow(1)).toBe('not_applicable');
    expect(canOpenNativeNotificationSettings()).toBe(false);
  });

  it('réglages : iOS → app-settings: par AppLauncher ; Android → indisponible (explication seule)', async () => {
    const launcher = { openUrl: vi.fn(async () => ({ completed: true })) };
    installNative({ AppLauncher: launcher }, 'ios');
    expect(canOpenNativeNotificationSettings()).toBe(true);
    expect(await openNativeNotificationSettings()).toBe(true);
    expect(launcher.openUrl).toHaveBeenCalledWith({ url: IOS_APP_SETTINGS_URL });
    expect(IOS_APP_SETTINGS_URL).toBe('app-settings:');
    launcher.openUrl.mockClear();
    installNative({ AppLauncher: launcher }, 'android');
    expect(canOpenNativeNotificationSettings()).toBe(false);
    expect(await openNativeNotificationSettings()).toBe(false);
    expect(launcher.openUrl).not.toHaveBeenCalled();
    installNative({}, 'ios'); // binaire sans AppLauncher
    expect(canOpenNativeNotificationSettings()).toBe(false);
  });
});

// ── L109G-SRC ───────────────────────────────────────────────────────────────

describe('L109G-SRC — branchements et binaires', () => {
  const runtime = read('src/components/native/NativeBridgeRuntime.tsx');

  it('runtime : plus de clé globale ; lot 113J demandes natives seules via le contrôleur commun', () => {
    expect(runtime).not.toMatch(/push-prompt-dismissed|PUSH_PROMPT_DISMISSED_KEY/);
    expect(runtime).not.toMatch(/shownThisRun|holdBiometrics|bioVisible/);
    expect(runtime).toMatch(/useNativePermissionsFlow\(features, blocked, offline\)/);
    expect(runtime).not.toMatch(/PushOnboardingCard|BiometricOfferCard|usePushOnboarding|useBiometricOffer/);
    expect(runtime).toMatch(/const blocked = locked \|\| commerce \|\| envMismatch \|\| updateRequired/);
    expect(runtime).toMatch(/APP_UPDATE_REQUIRED_EVENT/);
    // La demande native passe par le socle (`requestNativePush`), jamais directement par le runtime.
    expect(runtime).not.toMatch(/enableNativePush|requestPermissions/);
  });

  it('Mon compte › Notifications : accès « Ce téléphone » distinct des préférences, app native seulement', () => {
    const page = read('src/app/(dashboard)/mon-compte/notifications/page.tsx');
    expect(page).toMatch(/<NativePushDeviceSettings onChanged=\{refresh\} \/>/);
    const block = read('src/components/native/NativePushDeviceSettings.tsx');
    expect(block).toMatch(/if \(!native\) return null/);
    expect(block).toMatch(/requestNativePush\(\)/);
    expect(block).toMatch(/openNativeNotificationSettings\(\)/);
    expect(block).toMatch(/busyRef\.current/);
  });

  it('aucun Web Push réintroduit', () => {
    for (const f of [
      'src/lib/native/push-onboarding.ts', 'src/lib/native/native-permissions-flow.ts', 'src/components/native/useNativePermissionsFlow.ts',
      'src/components/native/NativePushDeviceSettings.tsx', 'src/app/(dashboard)/mon-compte/notifications/page.tsx',
    ]) {
      expect(read(f), f).not.toMatch(/Notification\.requestPermission|pushManager|PushManager/);
    }
  });

  it('binaires actuels suffisants : plugin, droits APNs, mode arrière-plan, AppLauncher (aucun nouveau build)', () => {
    expect(read('mobile/package.json')).toMatch(/"@capacitor-firebase\/messaging": "8\.5\.2"/);
    expect(read('mobile/package.json')).toMatch(/"@capacitor\/app-launcher"/);
    expect(read('mobile/ios/App/App/App.entitlements')).toMatch(/aps-environment/);
    expect(read('mobile/ios/App/App/Info.plist')).toMatch(/<string>remote-notification<\/string>/);
    const spm = read('mobile/ios/App/CapApp-SPM/Package.swift');
    expect(spm).toMatch(/CapacitorFirebaseMessaging/);
    expect(spm).toMatch(/CapacitorAppLauncher/);
    expect(read('mobile/android/app/src/main/AndroidManifest.xml')).not.toMatch(/POST_NOTIFICATIONS"\s+tools:node="remove"/);
  });
});
