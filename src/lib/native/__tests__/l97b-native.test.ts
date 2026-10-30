/**
 * Lot 97B — préparation de la mise en production de l'app (plugins Capacitor
 * simulés ; le Web doit rester inchangé) :
 *
 *   L97B-COM  aucun achat ni gestion commerciale dans l'app : pages, liens,
 *             boutons, portail Stripe, navigation directe (middleware) et API ;
 *             message sobre, SANS lien ; navigateur : aucun effet ;
 *   L97B-OAU  « Connecter » / « Confirmer avec » Google / Apple depuis Mon
 *             compte : navigateur système uniquement (jamais la vue), échange
 *             PKCE, erreurs de retour, adresse d'ouverture contrôlée ;
 *   L97B-BIO  réglage Biométrie : état réel du téléphone, activation après
 *             vérification réussie, refus géré, désactivation immédiate,
 *             AUCUN appel serveur.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const api = vi.hoisted(() => ({ get: vi.fn(async () => ({})) }));
vi.mock('@/lib/api-client', () => ({ apiClient: api }));

import { __resetShellInfoForTests } from '@/lib/native/shell-info';
import { SECURE_KEYS, SECURE_PREFIX, secureGet, secureSet } from '@/lib/native/secure-store';
import { aasaPatternToRegExp, resolveAppUrl } from '@/lib/native/deep-links';
import {
  abandonNativeOAuth, completeNativeOAuth, isAppContinueUrl, nativeOAuthErrorMessage, openNativeAccountOAuth,
  prepareNativeAccountOAuth,
} from '@/lib/native/oauth';
import {
  NATIVE_COMMERCE_API_PATHS, NATIVE_COMMERCE_INFO_PATH, NATIVE_COMMERCE_MESSAGE, NATIVE_COMMERCE_PATHS, isCommerceApiPath,
  isCommercePath, isNativeAppUserAgent, nativeCommerceHidden,
} from '@/lib/native/commerce';
import { biometryLabel, changeBiometrics, readBiometricSetting, setBiometricsEnabled, unlockPath } from '@/lib/native/app-lock';
import { setNativeFeatures } from '@/lib/native/features';
import { APP_LINK_EXCLUSIONS, OAUTH_APP_RETURN_PATH } from '@/lib/mobile/app-links';
import { SOCIAL_ERROR_MESSAGES } from '@/lib/auth/oauth/messages';
import { biometricsStatusText } from '@/components/account/security/BiometricsBlock';

const UA_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 VerebonaApp/1.4.0 (52; preprod)';
const UA_WEB = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15';
const ORIGIN = 'https://app.preprod.verebona.fr';
const CONTINUE = `${ORIGIN}/api/auth/oauth/app/continue?ticket=${'t'.repeat(43)}`;

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

function fakeSecureStorage(opts: { failSet?: boolean } = {}) {
  const store = new Map<string, string>();
  return {
    store,
    internalGetItem: vi.fn(async ({ prefixedKey }: { prefixedKey: string }) => ({ data: store.get(prefixedKey) ?? null })),
    internalSetItem: vi.fn(async ({ prefixedKey, data }: { prefixedKey: string; data: string }) => {
      if (opts.failSet) throw new Error('keystore');
      store.set(prefixedKey, data);
    }),
    internalRemoveItem: vi.fn(async ({ prefixedKey }: { prefixedKey: string }) => ({ success: store.delete(prefixedKey) })),
    internalClearItemsWithPrefix: vi.fn(async () => { store.clear(); }),
  };
}

function fakeBiometric(o: { available?: boolean; secure?: boolean; type?: number; refuse?: boolean } = {}) {
  return {
    checkBiometry: vi.fn(async () => ({ isAvailable: o.available ?? true, deviceIsSecure: o.secure ?? true, biometryType: o.type ?? 2 })),
    internalAuthenticate: vi.fn(async () => { if (o.refuse) throw Object.assign(new Error('userCancel'), { code: 'userCancel' }); }),
  };
}

function installNative(opts: { platform?: 'ios' | 'android'; plugins?: Record<string, unknown> } = {}) {
  const win = Object.assign(new EventTarget(), {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => opts.platform ?? 'ios', Plugins: opts.plugins ?? {} },
    location: { protocol: 'https:', origin: ORIGIN, pathname: '/mon-compte', search: '' },
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal('window', win);
  vi.stubGlobal('navigator', { userAgent: UA_IOS, standalone: false });
  return win;
}

function installWeb() {
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    location: { protocol: 'https:', origin: 'https://app.verebona.fr', pathname: '/mon-compte', search: '' },
    matchMedia: () => ({ matches: false }),
  }));
  vi.stubGlobal('navigator', { userAgent: UA_WEB, standalone: false });
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  __resetShellInfoForTests();
  setNativeFeatures(null);
  api.get.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── L97B-COM ────────────────────────────────────────────────────────────────

describe('L97B-COM — aucun achat ni gestion commerciale dans l’app', () => {
  it('pages commerciales : offres, abonnement (gestion, paiement), rétractation — préfixes exacts', () => {
    for (const p of ['/mon-compte/offres', '/mon-compte/offres?plan=premium'.split('?')[0], '/mon-compte/abonnement/gerer', '/mon-compte/abonnement/gerer/42',
      '/abonnement', '/abonnement/checkout', '/abonnement/success', '/abonnement/essai-termine']) {
      expect(isCommercePath(p), p).toBe(true);
    }
    // Lot 100D (décision PO A9) : la rétractation est un droit de l'utilisateur, ouverte dans l'app.
    expect(isCommercePath('/retractation')).toBe(false);
    for (const p of ['/mon-compte', '/mon-compte/notifications', '/mon-compte/offresX', '/abonnements', '/accueil', '/app/abonnement', null]) {
      expect(isCommercePath(p as string), String(p)).toBe(false);
    }
  });

  it('mêmes pages que les exclusions des liens universels (jamais ouvertes dans l’app)', () => {
    const exclusions = APP_LINK_EXCLUSIONS.map(aasaPatternToRegExp);
    for (const p of NATIVE_COMMERCE_PATHS) {
      expect(exclusions.some((re) => re.test(p)), p).toBe(true);
      expect(exclusions.some((re) => re.test(`${p}/x`)), p).toBe(true);
    }
    // L'écran d'information n'est pas commercial (pas de boucle de redirection).
    expect(isCommercePath(NATIVE_COMMERCE_INFO_PATH)).toBe(false);
  });

  it('opérations commerciales de l’API ; lectures (offre, essai, quotas) conservées', () => {
    for (const p of NATIVE_COMMERCE_API_PATHS) expect(isCommerceApiPath(p)).toBe(true);
    // Lot 100D (A9) : rétractation permise à l'app.
    expect(isCommerceApiPath('/api/withdrawal/confirm')).toBe(false);
    for (const p of ['/api/billing/me', '/api/billing/trial-status', '/api/billing/catalog', '/api/billing/upgradeX', '/api/users/me']) {
      expect(isCommerceApiPath(p), p).toBe(false);
    }
  });

  it('message sobre, sans lien ni adresse', () => {
    expect(NATIVE_COMMERCE_MESSAGE).toBe('La gestion de l’abonnement se fait sur le site.');
    expect(NATIVE_COMMERCE_MESSAGE).not.toMatch(/https?:|www\.|verebona\.(fr|com)|\.fr\b/i);
  });

  it('détection : agent utilisateur de l’app (serveur) ; vue de l’app (interface) ; navigateur jamais', () => {
    expect(isNativeAppUserAgent(UA_IOS)).toBe(true);
    expect(isNativeAppUserAgent(UA_WEB)).toBe(false);
    expect(isNativeAppUserAgent(null)).toBe(false);
    installWeb();
    expect(nativeCommerceHidden()).toBe(false);
    installNative();
    expect(nativeCommerceHidden()).toBe(true);
  });

  it('portail Stripe : jamais ouvert depuis l’app (aucune fenêtre, aucun appel)', async () => {
    installNative();
    const open = vi.fn();
    (window as unknown as { open: typeof open }).open = open;
    const { openBillingPortal } = await import('@/lib/billing/open-billing-portal');
    expect(await openBillingPortal()).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('L97B-COM — middleware : navigation directe et API', () => {
  const req = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    new NextRequest(`http://localhost:3000${path}`, { method, headers: { origin: 'http://localhost:3000', ...headers } });

  it('vue de l’app → écran d’information (offres, gestion, paiement, rétractation)', async () => {
    const { middleware, config } = await import('@/middleware');
    for (const p of ['/mon-compte/offres', '/mon-compte/abonnement/gerer/7', '/abonnement/checkout?plan=premium']) {
      const res = await middleware(req(p, { 'user-agent': UA_IOS }));
      expect(res.status, p).toBe(307);
      expect(new URL(res.headers.get('location')!).pathname, p).toBe(NATIVE_COMMERCE_INFO_PATH);
    }
    // Lot 100D (décision PO A9) : la rétractation est servie dans l'app (droit de l'utilisateur).
    expect((await middleware(req('/retractation', { 'user-agent': UA_IOS }))).headers.get('x-middleware-next')).toBe('1');
    expect(config.matcher).toEqual(expect.arrayContaining(['/abonnement/:path*', '/retractation/:path*']));
  });

  it('navigateur : inchangé (aucune redirection vers l’écran de l’app)', async () => {
    const { middleware } = await import('@/middleware');
    for (const p of ['/abonnement', '/abonnement/checkout', '/retractation']) {
      const res = await middleware(req(p, { 'user-agent': UA_WEB }));
      expect(res.headers.get('x-middleware-next'), p).toBe('1');
    }
    const offres = await middleware(req('/mon-compte/offres', { 'user-agent': UA_WEB }));
    expect(offres.headers.get('location') ?? '').not.toContain(NATIVE_COMMERCE_INFO_PATH);
  });

  it('API : opération commerciale refusée à un client natif déclaré (403), pas au Web', async () => {
    const { middleware } = await import('@/middleware');
    const app = await middleware(req('/api/billing/create-checkout-session', { 'x-verebona-client': 'IOS', 'x-verebona-app-version': '1.4.0' }, 'POST'));
    expect(app.status).toBe(403);
    expect(await app.json()).toMatchObject({ code: 'NOT_AVAILABLE_IN_APP', message: NATIVE_COMMERCE_MESSAGE });
    const android = await middleware(req('/api/billing/create-customer-portal-session', { 'x-verebona-client': 'ANDROID' }, 'POST'));
    expect(android.status).toBe(403);
    const web = await middleware(req('/api/billing/create-checkout-session', { 'x-verebona-client': 'web' }, 'POST'));
    expect(web.status).not.toBe(403); // laissé aux règles habituelles (session : 401)
    // Lecture de l'offre : jamais refusée à l'app.
    const lecture = await middleware(req('/api/billing/trial-status', { 'x-verebona-client': 'IOS' }));
    expect(lecture.status).not.toBe(403);
  });
});

// ── L97B-OAU ────────────────────────────────────────────────────────────────

describe('L97B-OAU — Mon compte › Sécurité : associer / confirmer Google ou Apple dans l’app', () => {
  it('Web : aucune préparation (parcours web inchangé)', async () => {
    installWeb();
    expect(await prepareNativeAccountOAuth('google', 'link')).toBeNull();
  });

  it('préparation : défi S256 pour le serveur, vérificateur au Keychain avec l’usage', async () => {
    const sec = fakeSecureStorage();
    installNative({ plugins: { SecureStorage: sec } });
    const body = await prepareNativeAccountOAuth('apple', 'reauth');
    expect(body?.client).toBe('app');
    expect(body?.appChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const pending = JSON.parse((await secureGet(SECURE_KEYS.oauthVerifier))!);
    expect(pending).toMatchObject({ provider: 'apple', purpose: 'reauth' });
    expect(pending.verifier).not.toBe(body?.appChallenge);
  });

  it('adresse d’ouverture : seulement celle de l’environnement du binaire, chemin et ticket prévus', () => {
    expect(isAppContinueUrl(CONTINUE, ORIGIN)).toBe(true);
    expect(isAppContinueUrl(CONTINUE.replace('app.preprod', 'app'), ORIGIN)).toBe(false);
    expect(isAppContinueUrl(`${ORIGIN}/api/auth/oauth/google/start?ticket=${'t'.repeat(43)}`, ORIGIN)).toBe(false);
    expect(isAppContinueUrl(`${ORIGIN}/api/auth/oauth/app/continue`, ORIGIN)).toBe(false);
    expect(isAppContinueUrl('https://accounts.google.com/o/oauth2/v2/auth', ORIGIN)).toBe(false);
    expect(isAppContinueUrl(42, ORIGIN)).toBe(false);
  });

  it('iOS : session d’authentification du système (jamais la vue), échange PKCE, action appliquée', async () => {
    const sec = fakeSecureStorage();
    const start = vi.fn(async () => ({ status: 'completed', url: `fr.verebona.app.preprod:/oauth?handoff=${'h'.repeat(43)}` }));
    installNative({ plugins: { SecureStorage: sec, VerebonaAuthSession: { start } } });
    await prepareNativeAccountOAuth('google', 'link');
    const verifier = JSON.parse((await secureGet(SECURE_KEYS.oauthVerifier))!).verifier;
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      success: true, intent: 'link', redirectTo: '/mon-compte/informations?securite=linked&provider=google#securite',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const r = await openNativeAccountOAuth(CONTINUE);
    expect(r).toEqual({ status: 'account_done', redirectTo: '/mon-compte/informations?securite=linked&provider=google#securite' });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ url: CONTINUE, callbackScheme: 'fr.verebona.app.preprod' }));
    // Session de la vue renouvelée AVANT l'échange (code à usage unique).
    expect(api.get).toHaveBeenCalledWith('/api/users/me/security');
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/oauth/app/exchange');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(String(init.body))).toEqual({ handoff: 'h'.repeat(43), verifier });
    expect(await secureGet(SECURE_KEYS.oauthVerifier)).toBeNull();
  });

  it('Android : Custom Tabs ouvert sur l’adresse d’ouverture, retour attendu par lien', async () => {
    const sec = fakeSecureStorage();
    const open = vi.fn(async () => undefined);
    installNative({ platform: 'android', plugins: { SecureStorage: sec, Browser: { open, close: vi.fn(async () => undefined) } } });
    await prepareNativeAccountOAuth('google', 'reauth');
    expect(await openNativeAccountOAuth(CONTINUE)).toEqual({ status: 'pending_return' });
    expect(open).toHaveBeenCalledWith({ url: CONTINUE, presentationStyle: 'fullscreen' });
  });

  it('adresse inattendue : rien n’est ouvert, vérificateur effacé', async () => {
    const sec = fakeSecureStorage();
    const open = vi.fn();
    installNative({ platform: 'android', plugins: { SecureStorage: sec, Browser: { open } } });
    await prepareNativeAccountOAuth('google', 'link');
    expect((await openNativeAccountOAuth('https://evil.example/api/auth/oauth/app/continue?ticket=xxxxxxxxxxxxxxxxxxxx')).status).toBe('failed');
    expect(open).not.toHaveBeenCalled();
    expect(sec.store.has(`${SECURE_PREFIX}${SECURE_KEYS.oauthVerifier}`)).toBe(false);
  });

  it('retour en erreur du serveur (`?error=`) : message stable, aucun échange', async () => {
    const ctx = { origin: ORIGIN, urlScheme: 'fr.verebona.app.preprod' };
    expect(resolveAppUrl(`${ORIGIN}${OAUTH_APP_RETURN_PATH}?error=OAUTH_IDENTITY_ALREADY_LINKED`, ctx))
      .toEqual({ kind: 'oauth_error', code: 'OAUTH_IDENTITY_ALREADY_LINKED' });
    expect(resolveAppUrl('fr.verebona.app.preprod:/oauth?error=OAUTH_STATE_INVALID', ctx)).toEqual({ kind: 'oauth_error', code: 'OAUTH_STATE_INVALID' });
    // Texte libre ou injecté : refusé.
    expect(resolveAppUrl(`${ORIGIN}${OAUTH_APP_RETURN_PATH}?error=<script>`, ctx)).toEqual({ kind: 'rejected', reason: 'oauth_without_code' });
    expect(nativeOAuthErrorMessage('OAUTH_IDENTITY_ALREADY_LINKED')).toBe(SOCIAL_ERROR_MESSAGES.OAUTH_IDENTITY_ALREADY_LINKED);

    const sec = fakeSecureStorage();
    const start = vi.fn(async () => ({ status: 'completed', url: 'fr.verebona.app.preprod:/oauth?error=REAUTH_SUBJECT_MISMATCH' }));
    installNative({ plugins: { SecureStorage: sec, VerebonaAuthSession: { start } } });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await prepareNativeAccountOAuth('apple', 'reauth');
    expect(await openNativeAccountOAuth(CONTINUE)).toEqual({ status: 'failed', message: SOCIAL_ERROR_MESSAGES.REAUTH_SUBJECT_MISMATCH });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('échange refusé (identité déjà liée ailleurs, autre session) : message du code, pas de connexion', async () => {
    const sec = fakeSecureStorage();
    installNative({ plugins: { SecureStorage: sec } });
    await secureSet(SECURE_KEYS.oauthVerifier, JSON.stringify({ verifier: 'v'.repeat(43), provider: 'google', startedAt: Date.now(), purpose: 'link' }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'OAUTH_IDENTITY_ALREADY_LINKED', error: 'x' }), { status: 409 })));
    expect(await completeNativeOAuth('h'.repeat(43))).toEqual({ status: 'failed', message: SOCIAL_ERROR_MESSAGES.OAUTH_IDENTITY_ALREADY_LINKED });
  });

  it('connexion (lot 95) inchangée : « signed_in », sans renouvellement préalable', async () => {
    const sec = fakeSecureStorage();
    installNative({ plugins: { SecureStorage: sec } });
    await secureSet(SECURE_KEYS.oauthVerifier, JSON.stringify({ verifier: 'v'.repeat(43), provider: 'google', startedAt: Date.now() }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, redirectTo: '/accueil' }), { status: 200 })));
    expect(await completeNativeOAuth('h'.repeat(43))).toEqual({ status: 'signed_in', redirectTo: '/accueil' });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('abandon : vérificateur effacé, navigateur fermé', async () => {
    const sec = fakeSecureStorage();
    const close = vi.fn(async () => undefined);
    installNative({ platform: 'android', plugins: { SecureStorage: sec, Browser: { open: vi.fn(), close } } });
    await prepareNativeAccountOAuth('google', 'link');
    await abandonNativeOAuth();
    expect(await secureGet(SECURE_KEYS.oauthVerifier)).toBeNull();
    expect(close).toHaveBeenCalled();
  });
});

// ── L97B-BIO ────────────────────────────────────────────────────────────────

describe('L97B-BIO — réglage Biométrie (Mon compte › Sécurité, app seulement)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy); });
  afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); }); // aucun effet serveur

  it('libellés du capteur', () => {
    expect(biometryLabel(2, 'ios')).toBe('Face ID');
    expect(biometryLabel(1, 'ios')).toBe('Touch ID');
    expect(biometryLabel(3, 'android')).toBe('l’empreinte digitale');
    expect(biometryLabel(null, 'ios')).toBe('Face ID ou Touch ID');
    expect(biometryLabel(0, 'android')).toBe('la biométrie du téléphone');
  });

  it('Web : non pris en charge (le bloc n’y est jamais affiché)', async () => {
    installWeb();
    expect(await readBiometricSetting()).toMatchObject({ supported: false, available: false, enabled: false });
  });

  it('état réel du téléphone, relu à chaque lecture', async () => {
    const bio = fakeBiometric({ available: true, type: 2 });
    installNative({ plugins: { SecureStorage: fakeSecureStorage(), BiometricAuthNative: bio } });
    expect(await readBiometricSetting('ios')).toEqual({ supported: true, available: true, deviceSecure: true, enabled: false, label: 'Face ID' });
    bio.checkBiometry.mockResolvedValueOnce({ isAvailable: false, deviceIsSecure: true, biometryType: 0 });
    expect(await readBiometricSetting('ios')).toMatchObject({ available: false, label: 'Face ID ou Touch ID' });
    bio.checkBiometry.mockRejectedValueOnce(new Error('plugin'));
    expect(await readBiometricSetting('ios')).toMatchObject({ supported: true, available: false });
  });

  it('activer : vérification réussie exigée, choix enregistré sur le téléphone', async () => {
    const sec = fakeSecureStorage();
    const bio = fakeBiometric();
    installNative({ plugins: { SecureStorage: sec, BiometricAuthNative: bio } });
    expect(await changeBiometrics(true)).toBe('enabled');
    expect(bio.internalAuthenticate).toHaveBeenCalledWith(expect.objectContaining({ allowDeviceCredential: false }));
    expect((await readBiometricSetting('ios')).enabled).toBe(true);
    expect(unlockPath({ biometricsEnabled: true, biometryAvailable: true, deviceSecure: true })).toBe('biometry');
  });

  it('refus / annulation : rien ne change', async () => {
    const sec = fakeSecureStorage();
    installNative({ plugins: { SecureStorage: sec, BiometricAuthNative: fakeBiometric({ refuse: true }) } });
    expect(await changeBiometrics(true)).toBe('refused');
    expect((await readBiometricSetting('ios')).enabled).toBe(false);
    expect(await setBiometricsEnabled(true)).toBe(false);
  });

  it('aucune biométrie configurée : activation impossible ; désactivation toujours possible', async () => {
    const sec = fakeSecureStorage();
    const bio = fakeBiometric({ available: false });
    installNative({ plugins: { SecureStorage: sec, BiometricAuthNative: bio } });
    expect(await changeBiometrics(true)).toBe('unavailable');
    expect(bio.internalAuthenticate).not.toHaveBeenCalled();
    await secureSet(SECURE_KEYS.biometricsEnabled, '1');
    expect(await changeBiometrics(false)).toBe('disabled');
    expect((await readBiometricSetting('ios')).enabled).toBe(false);
  });

  it('stockage sécurisé en échec : signalé, jamais présenté comme activé', async () => {
    installNative({ plugins: { SecureStorage: fakeSecureStorage({ failSet: true }), BiometricAuthNative: fakeBiometric() } });
    expect(await changeBiometrics(true)).toBe('storage_error');
  });

  it('textes d’état (bloc)', () => {
    const base = { supported: true, available: true, deviceSecure: true, enabled: true, label: 'Face ID' };
    expect(biometricsStatusText(base, true)).toBe('Activée : Face ID déverrouille Verebona sur ce téléphone.');
    expect(biometricsStatusText({ ...base, enabled: false }, true)).toMatch(/^Désactivée/);
    expect(biometricsStatusText({ ...base, available: false }, true)).toMatch(/n’est plus configurée/);
    expect(biometricsStatusText({ ...base, available: false, enabled: false }, true)).toMatch(/Aucune biométrie/);
    expect(biometricsStatusText(base, false)).toMatch(/momentanément indisponible/);
    expect(biometricsStatusText({ ...base, supported: false }, true)).toMatch(/ne permet pas/);
  });
});
