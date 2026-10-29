/**
 * Lot 95 — module natif partagé (`src/lib/native`) : no-op sur le Web,
 * comportements de la coque simulés (plugins Capacitor factices).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NATIVE_PLUGINS, isNativeApp, listenNative, nativePlatform, nativePlugin } from '@/lib/native/bridge';
import {
  APP_URL_SCHEMES, INSTALL_MARKER_KEY, __resetShellInfoForTests, appBuildEnv, appUrlContext, expectedServerEnvironment,
  initInstallationId, parseUserAgentMarker, runtimeShellInfo,
} from '@/lib/native/shell-info';
import { SECURE_KEYS, SECURE_PREFIX, secureGet, secureSet } from '@/lib/native/secure-store';
import { aasaPatternToRegExp, isAppRoutePath, pushTargetPath, resolveAppUrl } from '@/lib/native/deep-links';
import {
  NATIVE_OAUTH_TTL_MS, authSessionCallback, completeNativeOAuth, nativeOAuthStartUrl, newPkceVerifier, pkceChallengeS256,
} from '@/lib/native/oauth';
import { appOAuthReturnKind } from '@/lib/native/oauth-return';
import { nativeSignOutPush, pushRegistrationBody, unregisterNativePush } from '@/lib/native/push';
import { registerServiceWorker } from '@/lib/pwa/service-worker';
import { LOCK_AFTER_BACKGROUND_MS, UNLOCK_WITHOUT_BIOMETRICS, shouldLockOnResume, unlockPath } from '@/lib/native/app-lock';
import { imagesToPdf, scanFileName } from '@/lib/native/scan';
import { triageSharedFiles } from '@/lib/native/share-in';
import { CHUNK_BYTES, nativeUploadSender, tempUploadPath } from '@/lib/native/native-upload';
import { nativeFeatureOn, setNativeFeatures } from '@/lib/native/features';
import { clientPlatformHeaders } from '@/lib/client-platform';
import { mobileClientHeaders, nativeShellInfo } from '@/lib/mobile/native-shell';
import { APP_LINK_ROUTES, OAUTH_APP_RETURN_PATH, appleAppSiteAssociation } from '@/lib/mobile/app-links';
import {
  CREATE_FLOW_HOST_READY, OPEN_CREATE_FLOW, createFlowView, declareCreateFlowHost, isCreateFlowHostReady, openCreateFlow,
  parseCreateFlowRequest,
} from '@/lib/create-flows';

// ── Coque factice ────────────────────────────────────────────────────────────

const UA_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 VerebonaApp/1.4.0 (52; preprod)';
const ORIGIN = 'https://app.preprod.verebona.fr';

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
    _m: m,
  };
}

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

function installNative(opts: { platform?: 'ios' | 'android'; ua?: string; plugins?: Record<string, unknown>; native?: boolean } = {}) {
  const win = Object.assign(new EventTarget(), {
    Capacitor: {
      isNativePlatform: () => opts.native ?? true,
      getPlatform: () => opts.platform ?? 'ios',
      Plugins: opts.plugins ?? {},
      convertFileSrc: (p: string) => `${ORIGIN}/_capacitor_file_${p}`,
    },
    location: { protocol: 'https:', origin: ORIGIN, pathname: '/accueil', search: '' },
    matchMedia: () => ({ matches: false }),
  }) as unknown as Window & typeof globalThis;
  vi.stubGlobal('window', win);
  vi.stubGlobal('navigator', { userAgent: opts.ua ?? UA_IOS, standalone: false });
  return win;
}

function installWeb() {
  const win = Object.assign(new EventTarget(), {
    location: { protocol: 'https:', origin: 'https://app.verebona.fr', pathname: '/accueil', search: '' },
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal('window', win);
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh) Safari/605.1.15', standalone: false });
  return win;
}

let storage: ReturnType<typeof memoryStorage>;
beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  __resetShellInfoForTests();
  setNativeFeatures(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Web : aucun changement ───────────────────────────────────────────────────

describe('L95 — Web inchangé (no-op)', () => {
  it('hors navigateur (serveur) : rien de natif', async () => {
    expect(nativePlatform()).toBeNull();
    expect(isNativeApp()).toBe(false);
    expect(nativePlugin(NATIVE_PLUGINS.app)).toBeNull();
    expect(await secureGet('x')).toBeNull();
    expect(await secureSet('x', 'y')).toBe(false);
    expect(await initInstallationId()).toBeNull();
    expect(clientPlatformHeaders()).toEqual({});
  });

  it('navigateur : en-têtes web, aucune info de coque, aucune action native', async () => {
    installWeb();
    expect(isNativeApp()).toBe(false);
    expect(nativeShellInfo()).toBeNull();
    expect(mobileClientHeaders()).toEqual({});
    expect(clientPlatformHeaders()).toEqual({ 'X-Verebona-Client': 'web' });
    expect(appBuildEnv()).toBeNull();
    expect(appUrlContext()).toBeNull();
    const off = await listenNative(null, 'appUrlOpen', () => {});
    expect(() => off()).not.toThrow();
  });

  it('Capacitor présent mais non natif (navigateur avec le paquet web) : traité comme le Web', () => {
    installNative({ native: false });
    expect(isNativeApp()).toBe(false);
    expect(nativePlugin(NATIVE_PLUGINS.app)).toBeNull();
  });

  it('déconnexion web : la désinscription native n’est jamais appelée', async () => {
    installWeb();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(nativeSignOutPush()).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Pont et identité de la coque ────────────────────────────────────────────

describe('L95 — pont Capacitor et identité de l’app', () => {
  it('plateforme, plugins injectés, écoute (poignée directe ou promise)', async () => {
    const remove = vi.fn();
    const app = { addListener: vi.fn(() => ({ remove })) };
    const net = { addListener: vi.fn(async () => ({ remove })) };
    installNative({ platform: 'android', plugins: { App: app, Network: net } });
    expect(nativePlatform()).toBe('android');
    expect(nativePlugin(NATIVE_PLUGINS.app)).toBe(app);
    expect(nativePlugin(NATIVE_PLUGINS.scanner)).toBeNull();
    const off1 = await listenNative(app, 'appUrlOpen', () => {});
    const off2 = await listenNative(net, 'networkStatusChange', () => {});
    off1(); off2();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('marqueur d’agent utilisateur → contrat VerebonaNative synchrone + en-têtes X-Verebona-*', () => {
    expect(parseUserAgentMarker(UA_IOS)).toEqual({ appVersion: '1.4.0', build: '52', env: 'preprod' });
    expect(parseUserAgentMarker('VerebonaApp/1.4 (52; preprod)')).toBeNull();
    expect(parseUserAgentMarker('VerebonaApp/1.4.0 (52; recette)')).toBeNull();
    installNative();
    expect(runtimeShellInfo()).toEqual({ platform: 'ios', appVersion: '1.4.0', build: '52' });
    expect(nativeShellInfo()).toEqual({ platform: 'ios', appVersion: '1.4.0', build: '52' });
    expect(clientPlatformHeaders()).toEqual({ 'X-Verebona-Client': 'IOS', 'X-Verebona-App-Version': '1.4.0', 'X-Verebona-App-Build': '52' });
    expect(appBuildEnv()).toBe('preprod');
    expect(expectedServerEnvironment('prod')).toBe('production');
    expect(appUrlContext()).toEqual({ origin: ORIGIN, urlScheme: 'fr.verebona.app.preprod' });
  });

  it('app sans marqueur : plateforme seule (jamais de version devinée)', () => {
    installNative({ ua: 'Mozilla/5.0 (iPhone)' });
    expect(runtimeShellInfo()).toBeNull();
    expect(clientPlatformHeaders()).toEqual({ 'X-Verebona-Client': 'ios' });
  });

  it('schémas privés : préprod et prod distincts', () => {
    expect(APP_URL_SCHEMES).toEqual({ preprod: 'fr.verebona.app.preprod', prod: 'fr.verebona.app' });
  });
});

// ── Stockage sécurisé et réinstallation (AUTH-08, AUTH-13) ──────────────────

describe('L95 — Keychain / Keystore et identifiant d’installation', () => {
  it('écriture préfixée, non synchronisée, « cet appareil seulement »', async () => {
    const sec = fakeSecureStorage();
    installNative({ plugins: { SecureStorage: sec } });
    expect(await secureSet('k', 'v')).toBe(true);
    expect(sec.internalSetItem).toHaveBeenCalledWith({ prefixedKey: `${SECURE_PREFIX}k`, data: 'v', sync: false, access: 1 });
    expect(await secureGet('k')).toBe('v');
  });

  it('première ouverture : purge des valeurs héritées puis nouvel identifiant (réinstallation)', async () => {
    const sec = fakeSecureStorage();
    sec.store.set(`${SECURE_PREFIX}${SECURE_KEYS.installationId}`, 'ancien-identifiant-0000000000');
    sec.store.set(`${SECURE_PREFIX}${SECURE_KEYS.biometricsEnabled}`, '1');
    const win = installNative({ plugins: { SecureStorage: sec } });
    const id = await initInstallationId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(id).not.toBe('ancien-identifiant-0000000000');
    expect(sec.store.has(`${SECURE_PREFIX}${SECURE_KEYS.biometricsEnabled}`)).toBe(false);
    expect(storage.getItem(INSTALL_MARKER_KEY)).toBe('1');
    expect((win as unknown as { VerebonaNative?: { installationId?: string } }).VerebonaNative?.installationId).toBe(id);
    expect(clientPlatformHeaders()['X-Verebona-Installation-Id']).toBe(id);

    // Relance : même installation, même identifiant.
    __resetShellInfoForTests();
    expect(await initInstallationId()).toBe(id);
    expect(sec.internalClearItemsWithPrefix).toHaveBeenCalledTimes(1);
  });
});

// ── Liens entrants (§19, SEC-04) ─────────────────────────────────────────────

describe('L95 — liens universels, retour OAuth, notifications', () => {
  const ctx = { origin: ORIGIN, urlScheme: 'fr.verebona.app.preprod' };

  it('motifs AASA', () => {
    expect(aasaPatternToRegExp('/agenda*').test('/agenda/12')).toBe(true);
    expect(aasaPatternToRegExp('/duo/join/*').test('/duo/join/abc')).toBe(true);
    expect(aasaPatternToRegExp('/accueil').test('/accueil/a-traiter')).toBe(false);
    expect(isAppRoutePath('/mon-compte/offres')).toBe(false);
    expect(isAppRoutePath('/mon-compte')).toBe(true);
  });

  it('écran ciblé : chemin + requête conservés ; autre domaine ou chemin inconnu refusé', () => {
    expect(resolveAppUrl(`${ORIGIN}/documents?drawer=document:12`, ctx)).toEqual({ kind: 'route', path: '/documents?drawer=document:12' });
    expect(resolveAppUrl(`${ORIGIN}/assets/42`, ctx)).toEqual({ kind: 'route', path: '/assets/42' });
    expect(resolveAppUrl('https://app.verebona.fr/assets/42', ctx)).toEqual({ kind: 'rejected', reason: 'foreign_origin' });
    expect(resolveAppUrl('https://evil.example/assets/42', ctx)).toEqual({ kind: 'rejected', reason: 'foreign_origin' });
    expect(resolveAppUrl(`${ORIGIN}/admin/users`, ctx)).toEqual({ kind: 'external', url: `${ORIGIN}/admin/users` });
    expect(resolveAppUrl(`${ORIGIN}/mon-compte/abonnement`, ctx).kind).toBe('external');
    expect(resolveAppUrl(`${ORIGIN}/fournisseurs/3`, ctx)).toEqual({ kind: 'rejected', reason: 'unknown_path' });
    expect(resolveAppUrl(`http://app.preprod.verebona.fr/assets/1`, ctx).kind).toBe('rejected');
    expect(resolveAppUrl('javascript:alert(1)', ctx).kind).toBe('rejected');
    expect(resolveAppUrl(42, ctx).kind).toBe('rejected');
  });

  it('retour Google / Apple : https ou schéma privé, code obligatoire', () => {
    const handoff = 'a'.repeat(43);
    expect(resolveAppUrl(`${ORIGIN}${OAUTH_APP_RETURN_PATH}?handoff=${handoff}`, ctx)).toEqual({ kind: 'oauth', handoff });
    expect(resolveAppUrl(`fr.verebona.app.preprod:/oauth?handoff=${handoff}`, ctx)).toEqual({ kind: 'oauth', handoff });
    expect(resolveAppUrl(`fr.verebona.app.preprod://oauth?handoff=${handoff}`, ctx)).toEqual({ kind: 'oauth', handoff });
    expect(resolveAppUrl(`fr.verebona.app.preprod://autre?handoff=${handoff}`, ctx).kind).toBe('rejected');
    expect(resolveAppUrl(`fr.verebona.app://oauth?handoff=${handoff}`, ctx).kind).toBe('rejected');
    expect(resolveAppUrl(`${ORIGIN}${OAUTH_APP_RETURN_PATH}`, ctx)).toEqual({ kind: 'rejected', reason: 'oauth_without_code' });
  });

  it('le chemin de retour est déclaré dans l’association iOS (liste unique du lot 97)', () => {
    expect(APP_LINK_ROUTES.map((r) => r.path)).toContain(OAUTH_APP_RETURN_PATH);
    const aasa = appleAppSiteAssociation({ MOBILE_IOS_TEAM_ID: 'ABCDE12345', MOBILE_IOS_BUNDLE_IDS: 'fr.verebona.app.preprod' }) as {
      applinks: { details: Array<{ paths: string[] }> };
    };
    expect(aasa.applinks.details[0].paths).toContain(OAUTH_APP_RETURN_PATH);
  });

  it('notification : data.href validé, sinon rien', () => {
    expect(pushTargetPath({ href: `${ORIGIN}/agenda?date=2026-11-02&space=12` }, ctx)).toBe('/agenda?date=2026-11-02&space=12');
    expect(pushTargetPath({ href: 'https://evil.example/agenda' }, ctx)).toBeNull();
    expect(pushTargetPath(null, ctx)).toBeNull();
  });
});

// ── Google / Apple (M1) ─────────────────────────────────────────────────────

describe('L95 — connexion Google / Apple par le navigateur système', () => {
  it('PKCE : vérificateur et défi conformes au serveur (lot 93) ; vecteur RFC 7636', async () => {
    const v = newPkceVerifier();
    expect(v).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(await pkceChallengeS256(v)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await pkceChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('forme du retour annoncée par le serveur → retour attendu par la session iOS', () => {
    expect(appOAuthReturnKind(`${ORIGIN}${OAUTH_APP_RETURN_PATH}`)).toBe('https');
    expect(appOAuthReturnKind('fr.verebona.app.preprod:/oauth')).toBe('scheme');
    expect(appOAuthReturnKind('http://exemple.fr/x')).toBeNull();
    expect(appOAuthReturnKind(null)).toBeNull();
    const ctx = { origin: ORIGIN, urlScheme: 'fr.verebona.app.preprod' };
    expect(authSessionCallback('https', ctx)).toEqual({ callbackHost: 'app.preprod.verebona.fr', callbackPath: OAUTH_APP_RETURN_PATH });
    expect(authSessionCallback('scheme', ctx)).toEqual({ callbackScheme: 'fr.verebona.app.preprod' });
    expect(authSessionCallback(null, ctx)).toEqual({ callbackScheme: 'fr.verebona.app.preprod' });
  });

  it('URL de démarrage « application »', () => {
    const u = new URL(nativeOAuthStartUrl(ORIGIN, 'google', 'c'.repeat(43), { intent: 'login', returnUrl: '/agenda', ref: null }));
    expect(u.pathname).toBe('/api/auth/oauth/google/start');
    expect(u.searchParams.get('client')).toBe('app');
    expect(u.searchParams.get('app_challenge')).toBe('c'.repeat(43));
    expect(u.searchParams.get('returnUrl')).toBe('/agenda');
    expect(u.searchParams.has('ref')).toBe(false);
  });

  it('échange : vérificateur présenté une seule fois, session dans la vue, destination interne', async () => {
    const sec = fakeSecureStorage();
    installNative({ plugins: { SecureStorage: sec } });
    await secureSet(SECURE_KEYS.oauthVerifier, JSON.stringify({ verifier: 'v'.repeat(43), provider: 'google', startedAt: Date.now() }));
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ success: true, redirectTo: '/agenda' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    expect(await completeNativeOAuth('h'.repeat(43))).toEqual({ status: 'signed_in', redirectTo: '/agenda' });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/oauth/app/exchange');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(String(init.body))).toEqual({ handoff: 'h'.repeat(43), verifier: 'v'.repeat(43) });
    expect((init.headers as Record<string, string>)['X-Verebona-Client']).toBe('IOS');
    // Usage unique : un second retour échoue sans appel serveur.
    expect((await completeNativeOAuth('h'.repeat(43))).status).toBe('failed');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('parcours expiré ou destination externe : refus / repli sûr', async () => {
    const sec = fakeSecureStorage();
    installNative({ plugins: { SecureStorage: sec } });
    await secureSet(SECURE_KEYS.oauthVerifier, JSON.stringify({ verifier: 'v'.repeat(43), provider: 'apple', startedAt: Date.now() - NATIVE_OAUTH_TTL_MS - 1 }));
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ success: true, redirectTo: '//evil.example' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    expect((await completeNativeOAuth('h'.repeat(43))).status).toBe('failed');
    expect(fetchSpy).not.toHaveBeenCalled();
    await secureSet(SECURE_KEYS.oauthVerifier, JSON.stringify({ verifier: 'v'.repeat(43), provider: 'apple', startedAt: Date.now() }));
    expect(await completeNativeOAuth('h'.repeat(43))).toEqual({ status: 'signed_in', redirectTo: '/accueil' });
  });

  it('refus serveur : échec propre, aucune session supposée', async () => {
    const sec = fakeSecureStorage();
    installNative({ plugins: { SecureStorage: sec } });
    await secureSet(SECURE_KEYS.oauthVerifier, JSON.stringify({ verifier: 'v'.repeat(43), provider: 'google', startedAt: Date.now() }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Lien de connexion invalide ou expiré.', code: 'OAUTH_STATE_INVALID' }), { status: 400 })));
    expect(await completeNativeOAuth('h'.repeat(43))).toEqual({ status: 'failed', message: 'Lien de connexion invalide ou expiré.' });
  });
});

// ── Push (PUSH-08/09, AUTH-10) ──────────────────────────────────────────────

describe('L95 — notifications push natives', () => {
  it('corps d’enregistrement (contrat lot 97)', () => {
    expect(pushRegistrationBody({ installationId: 'i'.repeat(36), platform: 'android', pushToken: 't', appVersion: '1.0.0', build: null }))
      .toEqual({ installationId: 'i'.repeat(36), platform: 'android', pushToken: 't', appVersion: '1.0.0' });
  });

  it('déconnexion dans l’app : désinscription de CET appareil puis jeton local supprimé', async () => {
    const sec = fakeSecureStorage();
    const messaging = { deleteToken: vi.fn(async () => {}) };
    installNative({ platform: 'android', plugins: { SecureStorage: sec, FirebaseMessaging: messaging } });
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const unsubscribe = nativeSignOutPush();
    expect(unsubscribe).toBeDefined();
    await unsubscribe!();
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/mobile/push-installations/current');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(String(init.body)).installationId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(messaging.deleteToken).toHaveBeenCalled();
  });

  it('application : aucun service worker enregistré (M3) ; navigateur : enregistré', async () => {
    const register = vi.fn(async () => ({}) as ServiceWorkerRegistration);
    installNative({ plugins: { SecureStorage: fakeSecureStorage() } });
    vi.stubGlobal('navigator', { ...globalThis.navigator, serviceWorker: { register } });
    expect(await registerServiceWorker()).toBeNull();
    expect(register).not.toHaveBeenCalled();
    installWeb();
    vi.stubGlobal('navigator', { ...globalThis.navigator, serviceWorker: { register } });
    await registerServiceWorker();
    expect(register).toHaveBeenCalledWith('/sw.js');
  });

  it('jamais d’exception, même hors réseau', async () => {
    installNative({ plugins: { SecureStorage: fakeSecureStorage() } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(unregisterNativePush()).resolves.toBeUndefined();
  });
});

// ── Verrouillage (AUTH-09, REC-056/057) ─────────────────────────────────────

describe('L95 — verrouillage après 5 minutes en arrière-plan', () => {
  it('4 min : pas de verrou ; 5 min (inclus) et 6 min : verrou', () => {
    const t0 = 1_000_000;
    expect(LOCK_AFTER_BACKGROUND_MS).toBe(300_000);
    expect(shouldLockOnResume(t0, t0 + 4 * 60_000)).toBe(false);
    expect(shouldLockOnResume(t0, t0 + 5 * 60_000)).toBe(true);
    expect(shouldLockOnResume(t0, t0 + 6 * 60_000)).toBe(true);
    expect(shouldLockOnResume(null, t0)).toBe(false);
  });

  it('moyen de déverrouillage', () => {
    expect(unlockPath({ biometricsEnabled: true, biometryAvailable: true, deviceSecure: true })).toBe('biometry');
    expect(UNLOCK_WITHOUT_BIOMETRICS).toBe('device_credential');
    expect(unlockPath({ biometricsEnabled: false, biometryAvailable: true, deviceSecure: true })).toBe('device_credential');
    expect(unlockPath({ biometricsEnabled: true, biometryAvailable: false, deviceSecure: true })).toBe('device_credential');
    expect(unlockPath({ biometricsEnabled: false, biometryAvailable: false, deviceSecure: false })).toBe('full_sign_in');
  });
});

// ── Scanner (M9) ────────────────────────────────────────────────────────────

describe('L95 — scan → PDF multipage', () => {
  it('une page par image, dans l’ordre, résolution conservée', async () => {
    const sharp = (await import('sharp')).default;
    const page1 = await sharp({ create: { width: 20, height: 40, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    const page2 = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#000000' } }).png().toBuffer();
    const pdf = await imagesToPdf([
      { bytes: new Uint8Array(page1), mime: 'image/jpeg' },
      { bytes: new Uint8Array(page2), mime: 'image/png' },
    ]);
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(2);
    const [a, b] = doc.getPages().map((p) => p.getSize());
    expect(a.height / a.width).toBeCloseTo(2, 5);
    expect(b.height / b.width).toBeCloseTo(0.5, 5);
    await expect(imagesToPdf([])).rejects.toThrow();
  });

  it('nom du fichier', () => {
    expect(scanFileName(new Date(2026, 9, 26, 14, 5))).toBe('Scan 2026-10-26 14h05.pdf');
  });
});

// ── Partage entrant (IMP-02/03, REC-026) ────────────────────────────────────

describe('L95 — partage entrant', () => {
  it('PDF et images acceptés ; autres refusés avec nom et motif', () => {
    const r = triageSharedFiles([
      { uri: 'file:///a.pdf', name: 'facture.pdf', mimeType: 'application/pdf' },
      { uri: 'file:///b.jpg', name: 'photo.jpg', mimeType: 'IMAGE/JPEG' },
      { uri: 'file:///c.zip', name: 'archive.zip', mimeType: 'application/zip' },
      { name: 'sans-uri.pdf', mimeType: 'application/pdf' },
    ]);
    expect(r.accepted.map((f) => f.name)).toEqual(['facture.pdf', 'photo.jpg']);
    expect(r.refused.map((f) => f.name)).toEqual(['archive.zip', 'sans-uri.pdf']);
    expect(triageSharedFiles(null)).toEqual({ accepted: [], refused: [] });
  });
});

// ── Envoi natif de fond (UPL-01/02/05) ──────────────────────────────────────

describe('L95 — envoi natif de fond', () => {
  function fakePlugins() {
    let listener: ((e: unknown) => void) | null = null;
    const fs = {
      writeFile: vi.fn(async () => ({ uri: 'file:///cache/x' })),
      appendFile: vi.fn(async () => {}),
      getUri: vi.fn(async () => ({ uri: 'file:///cache/x' })),
      deleteFile: vi.fn(async () => {}),
    };
    const up = {
      addListener: vi.fn(async (_e: string, cb: (e: unknown) => void) => { listener = cb; return { remove: vi.fn() }; }),
      startUpload: vi.fn(async () => ({ id: 'u1' })),
      removeUpload: vi.fn(async () => {}),
      emit: (e: unknown) => listener?.(e),
    };
    return { fs, up };
  }

  it('Web : aucun envoi natif (XHR conservé)', () => {
    installWeb();
    expect(nativeUploadSender()).toBeNull();
  });

  it('copie privée par tranches, PUT natif vers l’URL signée, nettoyage après succès', async () => {
    const { fs, up } = fakePlugins();
    installNative({ plugins: { Filesystem: fs, Uploader: up } });
    const send = nativeUploadSender()!;
    const file = new File([new Uint8Array(CHUNK_BYTES + 10)], 'Facture été.pdf', { type: 'application/pdf' });
    const progress: number[] = [];
    const p = send('https://s3.example/put?sig=1', file, 'application/pdf', new AbortController().signal, (f) => progress.push(f));
    await vi.waitFor(() => expect(up.startUpload).toHaveBeenCalled());
    up.emit({ name: 'uploading', id: 'u1', payload: { percent: 50 } });
    up.emit({ name: 'completed', id: 'u1', payload: { statusCode: 200 } });
    await p;
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.appendFile).toHaveBeenCalledTimes(1);
    expect(up.startUpload).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://s3.example/put?sig=1', method: 'PUT', headers: { 'Content-Type': 'application/pdf' },
    }));
    expect(progress).toEqual([0.5, 1]);
    expect(fs.deleteFile).toHaveBeenCalled();
  });

  it('refus du stockage et annulation : erreur, transfert retiré, fichier temporaire effacé', async () => {
    const { fs, up } = fakePlugins();
    installNative({ plugins: { Filesystem: fs, Uploader: up } });
    const send = nativeUploadSender()!;
    const file = new File([new Uint8Array(10)], 'a.pdf', { type: 'application/pdf' });
    const p1 = send('https://s3.example/put', file, 'application/pdf', new AbortController().signal, () => {});
    await vi.waitFor(() => expect(up.startUpload).toHaveBeenCalledTimes(1));
    up.emit({ name: 'completed', id: 'u1', payload: { statusCode: 403 } });
    await expect(p1).rejects.toThrow('403');

    const ctrl = new AbortController();
    const p2 = send('https://s3.example/put', file, 'application/pdf', ctrl.signal, () => {});
    await vi.waitFor(() => expect(up.startUpload).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    ctrl.abort();
    await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
    expect(up.removeUpload).toHaveBeenCalledWith({ id: 'u1' });
    expect(fs.deleteFile).toHaveBeenCalledTimes(2);
  });

  it('nom temporaire sûr', () => {
    expect(tempUploadPath('../../Été 2026 (1).pdf', 'r')).toBe('verebona-envois/r-.._.._Ete_2026_1_.pdf');
  });
});

// ── Interrupteurs serveur (API-08) ──────────────────────────────────────────

describe('L95 — interrupteurs serveur', () => {
  it('actif tant que la configuration n’est pas lue ; coupure appliquée ensuite', () => {
    expect(nativeFeatureOn('scan')).toBe(true);
    setNativeFeatures({ scan: false, push: true });
    expect(nativeFeatureOn('scan')).toBe(false);
    expect(nativeFeatureOn('push')).toBe(true);
  });
});

// ── Parcours d'ajout avec fichiers (scan / partage) ─────────────────────────

describe('L95 — parcours de création avec fichiers', () => {
  it('fichiers transmis au formulaire de document seulement (Web : demandes inchangées)', () => {
    const f = new File(['x'], 'scan.pdf', { type: 'application/pdf' });
    expect(parseCreateFlowRequest({ flow: 'document', assetId: 3, files: [f, 'pas un fichier'] })).toEqual({ flow: 'document', assetId: 3, files: [f] });
    expect(parseCreateFlowRequest({ flow: 'asset', files: [f] })).toEqual({ flow: 'asset', assetId: null });
    expect(parseCreateFlowRequest({ flow: 'document', files: [] })).toEqual({ flow: 'document', assetId: null });
    expect(createFlowView({ flow: 'document', files: [f] }).initialFiles).toEqual([f]);
    expect('initialFiles' in createFlowView({ flow: 'document' })).toBe(false);
  });

  it('hôte prêt : signal émis, demande diffusée avec ses fichiers', () => {
    const win = installWeb();
    const ready = vi.fn();
    const opened = vi.fn();
    win.addEventListener(CREATE_FLOW_HOST_READY, ready);
    win.addEventListener(OPEN_CREATE_FLOW, (e) => opened((e as CustomEvent).detail));
    expect(isCreateFlowHostReady()).toBe(false);
    const retirer = declareCreateFlowHost();
    expect(isCreateFlowHostReady()).toBe(true);
    expect(ready).toHaveBeenCalledTimes(1);
    const f = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    openCreateFlow({ flow: 'document', files: [f] });
    expect(opened).toHaveBeenCalledWith({ flow: 'document', assetId: null, files: [f] });
    retirer();
    expect(isCreateFlowHostReady()).toBe(false);
  });
});
