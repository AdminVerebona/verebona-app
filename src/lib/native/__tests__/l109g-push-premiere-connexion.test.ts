/**
 * Lot 109G — invitation « Autoriser les notifications » à la première
 * connexion mobile. Pont natif SIMULÉ (Firebase Messaging, stockage sécurisé,
 * AppLauncher) ; le Web reste inchangé.
 *
 *   L109G-TXT   textes exacts du ticket, messages de réactivation iOS / Android ;
 *   L109G-RULE  décision (permission × décision enregistrée), écrans utilisables ;
 *   L109G-FLOW  parcours : APRÈS la biométrie (lot 111T, remplace la priorité
 *               push), « Plus tard », « Autoriser »,
 *               une seule demande, comptes A / B, gardes (CGUV, verrou, hors ligne,
 *               fonction coupée) ;
 *   L109G-STORE persistance par compte × installation, ancienne clé globale ;
 *   L109G-NATIVE socle push réel : une seule demande système, jeton enregistré,
 *               pas de faux « activé », réglages iOS ;
 *   L109G-SRC   branchements (runtime, Mon compte) et binaires inchangés.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LEGACY_PUSH_PROMPT_DISMISSED_KEY, PUSH_ONBOARDING_ALLOW, PUSH_ONBOARDING_LATER, PUSH_ONBOARDING_LOCAL_KEY,
  PUSH_ONBOARDING_TEXT, PUSH_ONBOARDING_TITLE, clearLegacyPushPromptKey, createPushOnboarding, devicePushStatusText,
  parsePushOnboardingDoc, pushOnboardingDecision, pushOnboardingScreenAllowed, pushOnboardingView, pushReenableHelp,
  pushRequestOutcomeMessage, readPushOnboarding, recordPushOnboarding,
  type PushOnboardingContext, type PushOnboardingDeps, type PushOnboardingRecord,
} from '@/lib/native/push-onboarding';
import {
  IOS_APP_SETTINGS_URL, canOpenNativeNotificationSettings, enableNativePush, openNativeNotificationSettings, requestNativePush,
} from '@/lib/native/push';
import { SECURE_KEYS, SECURE_PREFIX } from '@/lib/native/secure-store';
import { __resetShellInfoForTests } from '@/lib/native/shell-info';
import type { NativePushRequest, NativePushState } from '@/lib/native/push';

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

function ctx(o: Partial<PushOnboardingContext> = {}): PushOnboardingContext {
  return {
    userId: 1, featureOn: true, pathname: '/accueil', legalRequired: false, blocked: false, offline: false, held: false, ...o,
  };
}

function fakeDeps(o: { permission?: NativePushState; records?: Record<number, PushOnboardingRecord>; answer?: NativePushRequest } = {}) {
  const records: Record<number, PushOnboardingRecord> = { ...(o.records ?? {}) };
  let release: (() => void) | null = null;
  const deps = {
    permission: vi.fn(async () => o.permission ?? 'prompt'),
    read: vi.fn(async (u: number) => records[u] ?? null),
    record: vi.fn(async (u: number, s: PushOnboardingRecord['s'], r?: NativePushState) => {
      records[u] = { s, at: 'now', ...(r ? { r } : {}) };
      return true;
    }),
    request: vi.fn(() => new Promise<NativePushRequest>((res) => {
      release = () => res(o.answer ?? { state: 'granted', registered: true });
    })),
  } satisfies PushOnboardingDeps;
  return { deps, records, answer: () => { release?.(); } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  __resetShellInfoForTests();
});

// ── L109G-TXT ───────────────────────────────────────────────────────────────

describe('L109G-TXT — textes', () => {
  it('titre, texte et actions EXACTS du ticket', () => {
    expect(PUSH_ONBOARDING_TITLE).toBe('Autoriser les notifications ?');
    expect(PUSH_ONBOARDING_TEXT).toBe('Recevez vos rappels d’échéances et les informations utiles de Verebona sur ce téléphone. Vous pourrez choisir les notifications reçues dans Mon compte.');
    expect(PUSH_ONBOARDING_ALLOW).toBe('Autoriser les notifications');
    expect(PUSH_ONBOARDING_LATER).toBe('Plus tard');
    const card = read('src/components/native/PushOnboardingCard.tsx');
    for (const c of ['PUSH_ONBOARDING_TITLE', 'PUSH_ONBOARDING_TEXT', 'PUSH_ONBOARDING_ALLOW', 'PUSH_ONBOARDING_LATER']) expect(card).toContain(`{${c}}`);
    // Lot 111T : fenêtre centrée commune (boutons inactifs pendant la demande).
    expect(card).toMatch(/<NativeOfferDialog/);
    expect(read('src/components/native/NativeOfferDialog.tsx')).toMatch(/disabled=\{busy\}/);
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

  it('sans session ou fonction coupée par le serveur : rien', () => {
    const s = { decisions: { 1: 'offer' as const }, shown: 1, presented: true, busy: false };
    expect(pushOnboardingView(s, ctx({ userId: null }))).toEqual({ visible: false, busy: false });
    expect(pushOnboardingView(s, ctx({ featureOn: false }))).toEqual({ visible: false, busy: false });
    // Lot 111T : étape biométrique pas terminée → invitation retenue.
    expect(pushOnboardingView(s, ctx({ held: true }))).toEqual({ visible: false, busy: false });
    expect(pushOnboardingView(s, ctx())).toEqual({ visible: true, busy: false });
  });
});

// ── L109G-FLOW ──────────────────────────────────────────────────────────────

describe('L109G-FLOW — parcours de première connexion', () => {
  it('première connexion (lot 111T) : biométrie d’abord, puis invitation dans la même session, « Plus tard » sans demande OS', async () => {
    const { deps, records } = fakeDeps();
    const ctl = createPushOnboarding(deps);
    await ctl.evaluate(1);
    // Étape biométrique en cours (évaluation, fenêtre, vérification native) : attente, rien n'est noté.
    ctl.sync(ctx({ held: true }));
    expect(ctl.getSnapshot().shown).toBeNull();
    expect(deps.record).not.toHaveBeenCalled();
    // Encore sur l'écran de connexion (redirection en cours) : rien.
    ctl.sync(ctx({ pathname: '/login' }));
    expect(pushOnboardingView(ctl.getSnapshot(), ctx({ pathname: '/login' })).visible).toBe(false);
    // Étape biométrique terminée : invitation présentée sans relancement.
    ctl.sync(ctx());
    const v = pushOnboardingView(ctl.getSnapshot(), ctx());
    expect(v).toEqual({ visible: true, busy: false });
    await flush();
    expect(records[1]).toBeUndefined(); // pas encore réellement affichée
    ctl.presented(1);
    ctl.presented(1);
    await flush();
    expect(records[1].s).toBe('offered'); // noté à l'affichage réel, une fois
    expect(deps.record).toHaveBeenCalledTimes(1);
    ctl.later();
    await flush();
    expect(records[1].s).toBe('later');
    expect(deps.request).not.toHaveBeenCalled();
    expect(pushOnboardingView(ctl.getSnapshot(), ctx()).visible).toBe(false);
    // Navigation : jamais reproposée pendant ce lancement.
    ctl.sync(ctx({ pathname: '/documents' }));
    expect(pushOnboardingView(ctl.getSnapshot(), ctx({ pathname: '/documents' })).visible).toBe(false);
  });

  it('lancement suivant : décision « Plus tard » lue → aucune invitation', async () => {
    const { deps } = fakeDeps({ records: { 1: { s: 'later', at: 'x' } } });
    const ctl = createPushOnboarding(deps);
    await ctl.evaluate(1);
    ctl.sync(ctx());
    expect(pushOnboardingView(ctl.getSnapshot(), ctx())).toEqual({ visible: false, busy: false });
  });

  it('« Autoriser » : UNE seule demande même sur double appui, boutons inactifs, réponse notée', async () => {
    const { deps, records, answer } = fakeDeps();
    const ctl = createPushOnboarding(deps);
    await ctl.evaluate(1);
    ctl.sync(ctx());
    const p1 = ctl.allow();
    const p2 = ctl.allow();
    ctl.later(); // ignoré pendant la demande
    expect(pushOnboardingView(ctl.getSnapshot(), ctx()).busy).toBe(true);
    expect(await p2).toBeNull();
    answer();
    expect(await p1).toEqual({ state: 'granted', registered: true });
    expect(deps.request).toHaveBeenCalledTimes(1);
    expect(records[1]).toMatchObject({ s: 'answered', r: 'granted' });
    expect(pushOnboardingView(ctl.getSnapshot(), ctx()).visible).toBe(false);
  });

  it('autorisation déjà accordée ou refusée : aucune invitation', async () => {
    for (const permission of ['granted', 'denied'] as const) {
      const { deps } = fakeDeps({ permission });
      const ctl = createPushOnboarding(deps);
      await ctl.evaluate(1);
      ctl.sync(ctx());
      expect(pushOnboardingView(ctl.getSnapshot(), ctx())).toEqual({ visible: false, busy: false });
      expect(deps.record).not.toHaveBeenCalled();
    }
  });

  it('compte A « Plus tard » puis compte B sur le même téléphone : B a sa propre invitation', async () => {
    const { deps, records } = fakeDeps();
    const ctl = createPushOnboarding(deps);
    await ctl.evaluate(1);
    ctl.sync(ctx({ userId: 1 }));
    ctl.presented(1);
    ctl.later();
    await flush();
    // Déconnexion puis B.
    ctl.sync(ctx({ userId: null }));
    await ctl.evaluate(2);
    ctl.sync(ctx({ userId: 2 }));
    expect(pushOnboardingView(ctl.getSnapshot(), ctx({ userId: 2 })).visible).toBe(true);
    ctl.presented(2);
    await flush();
    expect(records[1].s).toBe('later');
    expect(records[2].s).toBe('offered');
  });

  it('changement de compte pendant l’affichage : l’invitation de A disparaît', async () => {
    const { deps } = fakeDeps({ records: { 2: { s: 'later', at: 'x' } } });
    const ctl = createPushOnboarding(deps);
    await ctl.evaluate(1);
    ctl.sync(ctx({ userId: 1 }));
    await ctl.evaluate(2);
    ctl.sync(ctx({ userId: 2 }));
    expect(ctl.getSnapshot().shown).toBeNull();
    expect(pushOnboardingView(ctl.getSnapshot(), ctx({ userId: 1 })).visible).toBe(false);
  });

  it('lot 111T — interrompue AVANT l’affichage réel (changement de compte, redirection) : pas perdue, rien de noté', async () => {
    const { deps, records } = fakeDeps({ records: { 2: { s: 'later', at: 'x' } } });
    const ctl = createPushOnboarding(deps);
    await ctl.evaluate(1);
    ctl.sync(ctx({ userId: 1 })); // prête, mais la fenêtre n'a pas encore été rendue
    await ctl.evaluate(2);
    ctl.sync(ctx({ userId: 2 }));
    await flush();
    expect(records[1]).toBeUndefined();
    // Retour du compte 1 dans la même session : l'invitation revient.
    ctl.sync(ctx({ userId: 1 }));
    expect(pushOnboardingView(ctl.getSnapshot(), ctx({ userId: 1 })).visible).toBe(true);
    // Rendue puis interrompue : notée, jamais reproposée.
    ctl.presented(1);
    ctl.sync(ctx({ userId: 2 }));
    ctl.sync(ctx({ userId: 1 }));
    await flush();
    expect(records[1].s).toBe('offered');
    expect(ctl.getSnapshot().shown).toBeNull();
  });

  it('CGUV à réaccepter, verrou, hors ligne, étape biométrique en cours : attente, puis affichage sur écran utile', async () => {
    const { deps } = fakeDeps();
    const ctl = createPushOnboarding(deps);
    await ctl.evaluate(1);
    for (const c of [{ legalRequired: true }, { blocked: true }, { offline: true }, { held: true }, { featureOn: false }]) {
      ctl.sync(ctx(c));
      expect(ctl.getSnapshot().shown, JSON.stringify(c)).toBeNull();
    }
    expect(deps.record).not.toHaveBeenCalled();
    ctl.sync(ctx());
    expect(ctl.getSnapshot().shown).toBe(1);
    // Session momentanément indisponible : masquée, pas perdue.
    ctl.sync(ctx({ userId: null }));
    expect(ctl.getSnapshot().shown).toBe(1);
    expect(pushOnboardingView(ctl.getSnapshot(), ctx({ userId: null })).visible).toBe(false);
    // Verrou après coup : masquée (pas détruite), revient au déverrouillage.
    expect(pushOnboardingView(ctl.getSnapshot(), ctx({ blocked: true })).visible).toBe(false);
    expect(pushOnboardingView(ctl.getSnapshot(), ctx()).visible).toBe(true);
  });

  it('lecture en échec : aucune invitation', async () => {
    const { deps } = fakeDeps();
    deps.permission.mockRejectedValueOnce(new Error('x'));
    const ctl = createPushOnboarding(deps);
    expect(await ctl.evaluate(1)).toBe('none');
    ctl.sync(ctx());
    expect(pushOnboardingView(ctl.getSnapshot(), ctx()).visible).toBe(false);
  });

  it('évaluée une fois par compte et par lancement', async () => {
    const { deps } = fakeDeps();
    const ctl = createPushOnboarding(deps);
    await Promise.all([ctl.evaluate(1), ctl.evaluate(1)]);
    await ctl.evaluate(1);
    expect(deps.permission).toHaveBeenCalledTimes(1);
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
    const ctl = createPushOnboarding();
    expect(await ctl.evaluate(7)).toBe('offer');
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

  it('parcours complet avec le socle réel : invitation, accord, réponse notée, plus d’invitation au lancement suivant', async () => {
    const sec = fakeSecureStorage();
    const m = fakeMessaging({ check: 'prompt-with-rationale', answer: 'granted' }); // Android 13+ après un premier refus
    const ls = installNative({ SecureStorage: sec, FirebaseMessaging: m }, 'android');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const ctl = createPushOnboarding();
    expect(await ctl.evaluate(1)).toBe('offer');
    ctl.sync(ctx());
    expect(await ctl.allow()).toEqual({ state: 'granted', registered: true });
    expect((await readPushOnboarding(1))).toMatchObject({ s: 'answered', r: 'granted' });
    // Lancement suivant (même installation) : autorisation accordée → aucune invitation.
    __resetShellInfoForTests();
    installNative({ SecureStorage: sec, FirebaseMessaging: m }, 'android', ls);
    expect(await createPushOnboarding().evaluate(1)).toBe('none');
  });

  it('Web : aucune demande, aucune invitation', async () => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { origin: 'https://app.verebona.fr' } }));
    expect(await requestNativePush()).toEqual({ state: 'unavailable', registered: false });
    expect(await createPushOnboarding().evaluate(1)).toBe('none');
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

  it('runtime : plus de clé globale ; lot 111T biométrie d’abord, notifications ensuite', () => {
    expect(runtime).not.toMatch(/push-prompt-dismissed|PUSH_PROMPT_DISMISSED_KEY/);
    expect(runtime).not.toMatch(/shownThisRun|holdBiometrics|bioVisible/);
    expect(runtime).toMatch(/useBiometricOffer\(features, blocked\)/);
    expect(runtime).toMatch(/usePushOnboarding\(featureOn\(features, 'push'\), blocked, offline, offer\.holdsPush\)/);
    expect(runtime).toMatch(/push\.visible && !offer\.visible/);
    expect(runtime).toMatch(/const blocked = locked \|\| commerce \|\| envMismatch \|\| updateRequired/);
    expect(runtime).toMatch(/APP_UPDATE_REQUIRED_EVENT/);
    expect(runtime).not.toMatch(/enableNativePush|requestPermissions/); // jamais de demande automatique
  });

  it('lot 111T : plus de report de la biométrie au lancement suivant', () => {
    const src = read('src/lib/native/push-onboarding.ts') + read('src/components/native/useBiometricOffer.ts');
    expect(src).not.toMatch(/holdBiometrics|shownThisRun/);
    expect(read('src/components/native/useBiometricOffer.ts')).not.toMatch(/held = false/);
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
      'src/lib/native/push-onboarding.ts', 'src/components/native/usePushOnboarding.ts', 'src/components/native/PushOnboardingCard.tsx',
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
