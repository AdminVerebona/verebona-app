/**
 * Lot 107A — Face ID automatique à la reprise et proposition d'activation
 * biométrique (#640). Pont natif SIMULÉ ; le Web doit rester inchangé.
 *
 *   L107A-MACH  machine d'états + contrôleur : reprise < / ≥ 5 min, démarrage
 *               à froid, échec, annulation, blocage, désactivé, indisponible,
 *               session expirée / révoquée, déconnexion, changement de compte,
 *               double reprise = une seule sollicitation, lien profond,
 *               horloge reculée, hors ligne, dépendance en échec ;
 *   L107A-CONS  choix par appareil ET par compte : jamais proposé / reporté /
 *               actif / indisponible / à réactiver, invalidation à
 *               l'enrôlement, nettoyage à la déconnexion, reprise de
 *               l'ancienne préférence, aucun appel serveur ;
 *   L107A-OFFR  proposition unique : conditions, textes ;
 *   L107A-BOOT  masquage avant tout rendu au démarrage à froid (natif seulement) ;
 *   L107A-SRC   écran « Verebona est verrouillé » retiré, coque native (plugin
 *               local, Info.plist), déconnexion branchée.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BACKGROUND_AT_KEY, LOCK_AFTER_BACKGROUND_MS, promptOutcomeFromError, retryLabel, shouldLockOnResume, verifyUserDetailed,
  type PromptOutcome,
} from '@/lib/native/app-lock';
import {
  BIOMETRIC_OFFER_DESCRIPTION, biometricOfferTitle, changeBiometrics, clearBiometricsOnSignOut, deferBiometrics,
  effectiveBiometricState, isBiometricOfferPath, nativeSignOutBiometrics, parseBiometricDoc, readBiometricSetting,
  resolveUnlockBiometry, shouldOfferBiometrics,
} from '@/lib/native/biometric-consent';
import { SECURE_KEYS, SECURE_PREFIX, secureSet } from '@/lib/native/secure-store';
import { LOCK_ATTRIBUTE, nativeLockBootScript } from '@/lib/native/lock-boot';
import { createUnlockController, type UnlockDeps } from '@/lib/native/unlock-controller';
import {
  INITIAL_UNLOCK_STATE, fallbackActionLabel, fallbackMessage, reduceUnlock,
  type SessionKnown, type UnlockMethod,
} from '@/lib/native/unlock-machine';

const ROOT = resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 3, 9, 0, 0);

// ── Doubles ─────────────────────────────────────────────────────────────────

function deferred<T>() {
  let resolveFn!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolveFn = r; });
  return { promise, resolve: resolveFn };
}

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

const BIO_ON: UnlockMethod = { biometry: true, biometryAvailable: true, deviceSecure: true };

function harness(o: { backgroundAt?: number | null; method?: UnlockMethod; verify?: { status: SessionKnown; userId: number | null } } = {}) {
  let clock = T0;
  let bg: number | null = o.backgroundAt ?? null;
  let covered = false;
  const prompts: Array<{ mode: string; d: ReturnType<typeof deferred<PromptOutcome>> }> = [];
  let method = o.method ?? BIO_ON;
  let verify = o.verify ?? { status: 'authenticated' as SessionKnown, userId: 1 };
  const deps = {
    now: () => clock,
    readBackgroundAt: () => bg,
    persistBackgroundAt: vi.fn((at: number) => { bg = at; }),
    clearBackgroundAt: vi.fn(() => { bg = null; }),
    readMethod: vi.fn(async (_userId: number | null) => method),
    prompt: vi.fn((mode: 'biometry' | 'device_credential') => {
      const d = deferred<PromptOutcome>();
      prompts.push({ mode, d });
      return d.promise;
    }),
    verifySession: vi.fn(async () => verify),
    navigate: vi.fn(),
    signInAgain: vi.fn(),
    exitSession: vi.fn(),
    onCover: vi.fn((c: boolean) => { covered = c; }),
  } satisfies UnlockDeps;
  const c = createUnlockController(deps);
  return {
    c, deps, prompts,
    get covered() { return covered; },
    get bg() { return bg; },
    advance(ms: number) { clock += ms; },
    setMethod(m: UnlockMethod) { method = m; },
    setVerify(v: { status: SessionKnown; userId: number | null }) { verify = v; },
    session(status: SessionKnown, userId: number | null = 1) { c.dispatch({ type: 'SESSION', status, userId }); },
    phase: () => c.getState().phase,
  };
}

/** Session ouverte, app au premier plan, puis passage en arrière-plan. */
async function unlockedThenBackground(h: ReturnType<typeof harness>) {
  h.c.boot();
  h.session('authenticated', 1);
  await flush();
  h.c.background();
}

// ── L107A-MACH ──────────────────────────────────────────────────────────────

describe('L107A-MACH — déverrouillage automatique (machine + contrôleur, pont simulé)', () => {
  it('règle des 5 min mesurée sur le temps en ARRIÈRE-PLAN ; horloge reculée → verrou', () => {
    expect(LOCK_AFTER_BACKGROUND_MS).toBe(5 * MIN);
    expect(shouldLockOnResume(T0, T0 + 4 * MIN + 59_000)).toBe(false);
    expect(shouldLockOnResume(T0, T0 + 5 * MIN)).toBe(true);
    expect(shouldLockOnResume(T0, T0 - 1)).toBe(true);
    expect(shouldLockOnResume(null, T0)).toBe(false);
    // Aucun minuteur d'inactivité au premier plan : sans passage en arrière-plan, jamais de verrou.
    let s = reduceUnlock(INITIAL_UNLOCK_STATE, { type: 'BOOT', now: T0, backgroundAt: null }).state;
    s = reduceUnlock(s, { type: 'SESSION', status: 'authenticated', userId: 1 }).state;
    s = reduceUnlock(s, { type: 'RESUME', now: T0 + 60 * MIN, backgroundAt: null }).state;
    expect(s.phase).toBe('unlocked');
  });

  it('reprise < 5 min : dernier écran tout de suite, ni Face ID ni écran', async () => {
    const h = harness();
    await unlockedThenBackground(h);
    expect(h.covered).toBe(true); // aperçu protégé pendant l'arrière-plan
    expect(h.deps.persistBackgroundAt).toHaveBeenCalledWith(T0);
    h.advance(4 * MIN);
    h.c.resume();
    await flush();
    expect(h.phase()).toBe('unlocked');
    expect(h.covered).toBe(false);
    expect(h.deps.prompt).not.toHaveBeenCalled();
    expect(h.deps.readMethod).not.toHaveBeenCalled();
    expect(h.bg).toBeNull();
  });

  it('reprise ≥ 5 min : Face ID lancé AUTOMATIQUEMENT, succès → app visible sans autre étape', async () => {
    const h = harness();
    await unlockedThenBackground(h);
    h.advance(6 * MIN);
    h.c.resume();
    expect(h.covered).toBe(true);
    await flush();
    expect(h.deps.verifySession).toHaveBeenCalledTimes(1); // session serveur relue
    expect(h.deps.readMethod).toHaveBeenCalledWith(1);
    expect(h.deps.prompt).toHaveBeenCalledTimes(1);
    expect(h.prompts[0].mode).toBe('biometry');
    expect(h.phase()).toBe('prompting');
    h.prompts[0].d.resolve('ok');
    await flush();
    expect(h.phase()).toBe('unlocked');
    expect(h.covered).toBe(false);
    expect(h.c.getState().fallback).toBeNull();
    expect(h.bg).toBeNull();
    expect(h.deps.navigate).not.toHaveBeenCalled(); // le dernier écran n'a jamais été démonté
  });

  it('démarrage à froid après 5 min : masqué AVANT la session, Face ID dès la session connue', async () => {
    const h = harness({ backgroundAt: T0 - 30 * MIN });
    h.c.boot();
    expect(h.covered).toBe(true);
    expect(h.deps.onCover).toHaveBeenLastCalledWith(true);
    await flush();
    expect(h.deps.prompt).not.toHaveBeenCalled(); // session encore inconnue
    h.session('authenticated', 1);
    await flush();
    expect(h.deps.verifySession).not.toHaveBeenCalled(); // la première lecture fait foi
    expect(h.deps.prompt).toHaveBeenCalledTimes(1);
    h.prompts[0].d.resolve('ok');
    await flush();
    expect(h.covered).toBe(false);
  });

  it('démarrage à froid < 5 min : rien', async () => {
    const h = harness({ backgroundAt: T0 - 2 * MIN });
    h.c.boot();
    expect(h.covered).toBe(false);
    expect(h.deps.onCover).toHaveBeenLastCalledWith(false); // reprend la main sur le script de démarrage
    expect(h.deps.clearBackgroundAt).toHaveBeenCalled();
  });

  it('échec : écran de secours, AUCUNE relance automatique ; « Réessayer » volontaire', async () => {
    const h = harness({ backgroundAt: T0 - 10 * MIN });
    h.c.boot(); h.session('authenticated', 1); await flush();
    h.prompts[0].d.resolve('failed');
    await flush();
    expect(h.phase()).toBe('fallback');
    expect(h.covered).toBe(true);
    // Lot 111D : « Réessayer Face ID », code du téléphone explicite, reconnexion en dernier (ticket #642 bis).
    expect(h.c.getState().fallback).toMatchObject({ reason: 'failed', actions: ['retry_biometry', 'device_credential', 'sign_in'] });
    // Retour de la fenêtre système (inactive → active) : pas de nouvelle fenêtre.
    h.c.resume(); await flush();
    expect(h.deps.prompt).toHaveBeenCalledTimes(1);
    h.c.dispatch({ type: 'RETRY' }); await flush();
    expect(h.deps.prompt).toHaveBeenCalledTimes(2);
    h.prompts[1].d.resolve('ok'); await flush();
    expect(h.phase()).toBe('unlocked');
  });

  it('annulation → autre méthode (code du téléphone) → annulation → « Se reconnecter »', async () => {
    const h = harness({ backgroundAt: T0 - 10 * MIN });
    h.c.boot(); h.session('authenticated', 1); await flush();
    h.prompts[0].d.resolve('cancelled'); await flush();
    expect(h.c.getState().fallback?.reason).toBe('cancelled');
    h.c.dispatch({ type: 'OTHER_METHOD' }); await flush();
    expect(h.prompts[1].mode).toBe('device_credential');
    h.prompts[1].d.resolve('cancelled'); await flush();
    expect(h.c.getState().fallback).toMatchObject({ mode: 'device_credential', actions: ['device_credential', 'sign_in'] });
    h.c.dispatch({ type: 'NAVIGATE', path: '/documents/9' });
    h.c.dispatch({ type: 'SIGN_IN' });
    expect(h.deps.signInAgain).toHaveBeenCalledWith('/documents/9');
    expect(h.covered).toBe(true); // jamais de contenu avant la connexion
  });

  it('« Utiliser une autre méthode » sans code sur le téléphone → connexion complète', async () => {
    const h = harness({ backgroundAt: T0 - 10 * MIN, method: { biometry: true, biometryAvailable: true, deviceSecure: false } });
    h.c.boot(); h.session('authenticated', 1); await flush();
    // Sans code, la biométrie reste possible (biometryAvailable) : la fenêtre « code » du système la propose.
    h.prompts[0].d.resolve('cancelled'); await flush();
    // Biométrie devenue inutilisable entre-temps et aucun code : connexion complète.
    const s = reduceUnlock({ ...h.c.getState(), method: { biometry: true, biometryAvailable: false, deviceSecure: false } }, { type: 'OTHER_METHOD' });
    expect(s.effects).toEqual([{ type: 'sign_in_again', returnPath: null }]);
  });

  it('blocage système (trop d’échecs) : pas de « Réessayer Face ID »', async () => {
    const h = harness({ backgroundAt: T0 - 10 * MIN });
    h.c.boot(); h.session('authenticated', 1); await flush();
    h.prompts[0].d.resolve('lockout'); await flush();
    expect(h.c.getState().fallback).toMatchObject({ reason: 'lockout', actions: ['device_credential', 'sign_in'] });
    h.c.dispatch({ type: 'RETRY' }); await flush();
    expect(h.deps.prompt).toHaveBeenCalledTimes(1);
  });

  it('biométrie non activée : écran de secours (code du téléphone / se reconnecter), aucune fenêtre automatique', async () => {
    const h = harness({ backgroundAt: T0 - 10 * MIN, method: { biometry: false, biometryAvailable: true, deviceSecure: true, whyNot: 'not_enabled' } });
    h.c.boot(); h.session('authenticated', 1); await flush();
    expect(h.deps.prompt).not.toHaveBeenCalled();
    expect(h.c.getState().fallback).toMatchObject({ reason: 'not_enabled', actions: ['device_credential', 'sign_in'] });
    h.c.dispatch({ type: 'DEVICE_CREDENTIAL' }); await flush();
    h.prompts[0].d.resolve('ok'); await flush();
    expect(h.phase()).toBe('unlocked');
  });

  it('biométrie indisponible et téléphone sans code : seule issue « Se reconnecter » (jamais d’écran sans issue)', async () => {
    const h = harness({ backgroundAt: T0 - 10 * MIN, method: { biometry: false, biometryAvailable: false, deviceSecure: false, whyNot: 'unavailable' } });
    h.c.boot(); h.session('authenticated', 1); await flush();
    expect(h.c.getState().fallback).toMatchObject({ reason: 'unavailable', actions: ['sign_in'] });
  });

  it('enrôlement modifié : écran « à réactiver », pas de Face ID', async () => {
    const h = harness({ backgroundAt: T0 - 10 * MIN, method: { biometry: false, biometryAvailable: true, deviceSecure: true, whyNot: 'reactivate' } });
    h.c.boot(); h.session('authenticated', 1); await flush();
    expect(h.deps.prompt).not.toHaveBeenCalled();
    expect(h.c.getState().fallback?.reason).toBe('reactivate');
  });

  it('session expirée / révoquée à la reprise : Face ID ne contourne JAMAIS le serveur (deux ordres d’arrivée)', async () => {
    // a) la relecture serveur répond avant la biométrie
    const a = harness({ verify: { status: 'unauthenticated', userId: null } });
    await unlockedThenBackground(a);
    a.advance(6 * MIN); a.c.resume(); await flush();
    expect(a.deps.exitSession).toHaveBeenCalledTimes(1);
    a.prompts[0]?.d.resolve('ok'); await flush();
    expect(a.deps.navigate).not.toHaveBeenCalled();
    expect(a.c.getState().session).toBe('unauthenticated');

    // b) la biométrie réussit avant la réponse du serveur : rien n'est montré avant
    const b = harness();
    const v = deferred<{ status: SessionKnown; userId: number | null }>();
    b.deps.verifySession.mockImplementationOnce(() => v.promise);
    await unlockedThenBackground(b);
    b.advance(6 * MIN); b.c.resume(); await flush();
    b.prompts[0].d.resolve('ok'); await flush();
    expect(b.phase()).toBe('verifying');
    expect(b.covered).toBe(true);
    v.resolve({ status: 'unauthenticated', userId: null }); await flush();
    expect(b.deps.exitSession).toHaveBeenCalledTimes(1);
  });

  it('démarrage à froid sans session (révoquée, expirée) : pas de Face ID, écran de connexion', async () => {
    const h = harness({ backgroundAt: T0 - 60 * MIN });
    h.c.boot();
    h.session('unauthenticated', null); await flush();
    expect(h.deps.prompt).not.toHaveBeenCalled();
    expect(h.covered).toBe(false);
    expect(h.deps.exitSession).not.toHaveBeenCalled(); // la procédure habituelle des pages s'applique
  });

  it('déconnexion pendant le verrou : retour à la connexion, préférence non utilisée', async () => {
    const h = harness({ backgroundAt: T0 - 10 * MIN });
    h.c.boot(); h.session('authenticated', 1); await flush();
    h.prompts[0].d.resolve('cancelled'); await flush();
    h.session('unauthenticated', null);
    expect(h.phase()).toBe('unlocked');
    expect(h.covered).toBe(false);
    h.c.dispatch({ type: 'SIGNED_OUT' });
    expect(h.bg).toBeNull();
  });

  it('changement de compte pendant le verrou : moyen relu pour le NOUVEAU compte, réponses de l’ancien ignorées', async () => {
    const h = harness({ backgroundAt: T0 - 10 * MIN });
    const slow = deferred<UnlockMethod>();
    h.deps.readMethod.mockImplementationOnce(() => slow.promise);
    h.c.boot(); h.session('authenticated', 1); await flush();
    h.session('authenticated', 2); await flush();
    expect(h.deps.readMethod).toHaveBeenLastCalledWith(2);
    expect(h.deps.prompt).toHaveBeenCalledTimes(1); // moyen du compte 2
    const attempt = h.c.getState().attempt;
    slow.resolve(BIO_ON); await flush(); // réponse tardive du compte 1
    expect(h.deps.prompt).toHaveBeenCalledTimes(1);
    expect(h.c.getState().attempt).toBe(attempt);
  });

  it('résultat tardif d’une tentative périmée : ignoré', async () => {
    const h = harness({ backgroundAt: T0 - 10 * MIN });
    h.c.boot(); h.session('authenticated', 1); await flush();
    const old = h.c.getState().attempt;
    h.session('authenticated', 2); await flush(); // nouvelle tentative
    h.c.dispatch({ type: 'PROMPT_RESULT', attempt: old, outcome: 'ok' });
    expect(h.phase()).toBe('prompting');
  });

  it('double reprise / fenêtre système : UNE seule sollicitation par reprise', async () => {
    const h = harness();
    await unlockedThenBackground(h);
    h.advance(6 * MIN);
    h.c.resume(); h.c.resume(); await flush();
    // La fenêtre Face ID rend l'app inactive puis active : ignoré.
    h.c.background(); h.c.resume(); h.c.background(); h.c.resume(); await flush();
    expect(h.deps.prompt).toHaveBeenCalledTimes(1);
    expect(h.deps.persistBackgroundAt).toHaveBeenCalledTimes(1);
    h.prompts[0].d.resolve('cancelled'); await flush();
    // Vrai départ en arrière-plan depuis l'écran de secours puis retour : nouvelle sollicitation (une).
    h.c.background(); h.advance(MIN); h.c.resume(); h.c.resume(); await flush();
    expect(h.deps.prompt).toHaveBeenCalledTimes(2);
    expect(h.deps.verifySession).toHaveBeenCalledTimes(2);
  });

  it('lien profond / notification pendant le verrou : destination ouverte APRÈS le déverrouillage', async () => {
    const h = harness();
    await unlockedThenBackground(h);
    h.c.dispatch({ type: 'NAVIGATE', path: '/agenda' }); // reçu pendant l'arrière-plan
    h.advance(10 * MIN); h.c.resume(); await flush();
    expect(h.deps.navigate).not.toHaveBeenCalled();
    h.prompts[0].d.resolve('ok'); await flush();
    expect(h.deps.navigate).toHaveBeenCalledTimes(1);
    expect(h.deps.navigate).toHaveBeenCalledWith('/agenda');

    // Reprise < 5 min : ouvert aussitôt ; app visible : navigation directe.
    const k = harness();
    await unlockedThenBackground(k);
    k.c.dispatch({ type: 'NAVIGATE', path: '/documents' });
    k.advance(MIN); k.c.resume(); await flush();
    expect(k.deps.navigate).toHaveBeenCalledWith('/documents');
    k.c.dispatch({ type: 'NAVIGATE', path: '/accueil' });
    expect(k.deps.navigate).toHaveBeenLastCalledWith('/accueil');
  });

  it('hors ligne : session « momentanément indisponible » → déverrouillage local permis (aucune donnée nouvelle)', async () => {
    const h = harness({ verify: { status: 'temporarily-unavailable', userId: 1 } });
    await unlockedThenBackground(h);
    h.advance(6 * MIN); h.c.resume(); await flush();
    h.prompts[0].d.resolve('ok'); await flush();
    expect(h.phase()).toBe('unlocked');
  });

  it('dépendance en échec (lecture du moyen) : écran de secours avec issue, jamais bloqué', async () => {
    const h = harness({ backgroundAt: T0 - 10 * MIN });
    h.deps.readMethod.mockRejectedValueOnce(new Error('keystore'));
    h.c.boot(); h.session('authenticated', 1); await flush();
    expect(h.c.getState().fallback?.actions).toContain('sign_in');
  });

  it('textes de l’écran de secours : sobres, sans explication des 5 minutes', () => {
    expect(fallbackMessage({ reason: 'failed', mode: 'biometry' }, 'Face ID')).toBe('Face ID n’a pas abouti.');
    expect(fallbackMessage({ reason: 'lockout', mode: 'biometry' }, 'la biométrie')).toBe('Le téléphone a momentanément bloqué la biométrie.');
    expect(fallbackMessage({ reason: 'unavailable', mode: 'biometry' }, 'la biométrie')).toBe('La biométrie n’est pas disponible pour le moment.');
    expect(fallbackMessage({ reason: 'reactivate', mode: 'device_credential' }, 'Face ID')).toMatch(/Mon compte › Sécurité/);
    for (const r of ['cancelled', 'failed', 'interrupted', 'lockout', 'unavailable', 'reactivate', 'not_enabled'] as const) {
      expect(fallbackMessage({ reason: r, mode: 'biometry' }, 'Face ID')).not.toMatch(/5 minutes|verrouill/i);
    }
    expect(fallbackActionLabel('retry_biometry', retryLabel(2, 'ios'))).toBe('Réessayer Face ID');
    expect(retryLabel(1, 'ios')).toBe('Réessayer Touch ID');
    expect(retryLabel(3, 'android')).toBe('Réessayer avec la biométrie');
    expect(fallbackActionLabel('other_method', '')).toBe('Utiliser une autre méthode');
  });

  it('codes d’erreur du plugin → résultat', () => {
    expect(promptOutcomeFromError({ code: 'userCancel' })).toBe('cancelled');
    expect(promptOutcomeFromError({ code: 'userFallback' })).toBe('cancelled');
    expect(promptOutcomeFromError({ code: 'authenticationFailed' })).toBe('failed');
    expect(promptOutcomeFromError({ code: 'biometryLockout' })).toBe('lockout');
    expect(promptOutcomeFromError({ code: 'systemCancel' })).toBe('interrupted');
    expect(promptOutcomeFromError({ code: 'biometryNotEnrolled' })).toBe('unavailable');
    expect(promptOutcomeFromError(new Error('x'))).toBe('failed');
  });
});

// ── Pont natif simulé (stockage sécurisé, biométrie, plugin d'enrôlement) ──

function fakeSecureStorage() {
  const store = new Map<string, string>();
  return {
    store,
    internalGetItem: vi.fn(async ({ prefixedKey }: { prefixedKey: string }) => ({ data: store.get(prefixedKey) ?? null })),
    internalSetItem: vi.fn(async ({ prefixedKey, data }: { prefixedKey: string; data: string }) => { store.set(prefixedKey, data); }),
    internalRemoveItem: vi.fn(async ({ prefixedKey }: { prefixedKey: string }) => ({ success: store.delete(prefixedKey) })),
    internalClearItemsWithPrefix: vi.fn(async () => { store.clear(); }),
  };
}

function fakeBiometric(o: { available?: boolean; secure?: boolean; type?: number; error?: string } = {}) {
  return {
    checkBiometry: vi.fn(async () => ({ isAvailable: o.available ?? true, deviceIsSecure: o.secure ?? true, biometryType: o.type ?? 2 })),
    internalAuthenticate: vi.fn(async () => { if (o.error) throw Object.assign(new Error(o.error), { code: o.error }); }),
  };
}

function installNative(plugins: Record<string, unknown>, platform: 'ios' | 'android' = 'ios') {
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => platform, Plugins: plugins },
    location: { protocol: 'https:', origin: 'https://app.preprod.verebona.fr', pathname: '/accueil', search: '' },
  }));
}

function installWeb() {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { protocol: 'https:', origin: 'https://app.verebona.fr', pathname: '/accueil', search: '' } }));
}

const stateKey = `${SECURE_PREFIX}${SECURE_KEYS.biometricsState}`;

describe('L107A-CONS — choix par appareil ET par compte (Keychain / Keystore simulés)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy); });
  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled(); // aucun effet serveur, aucune donnée envoyée
    vi.unstubAllGlobals();
  });

  it('jamais proposé → reporté (proposition vue) → jamais reproposé ; activation après vérification réussie', async () => {
    const sec = fakeSecureStorage();
    installNative({ SecureStorage: sec, BiometricAuthNative: fakeBiometric() });
    expect((await readBiometricSetting('ios', 1)).state).toBe('never');
    await deferBiometrics(1, 'offered');
    expect((await readBiometricSetting('ios', 1)).state).toBe('deferred');
    await deferBiometrics(1, 'later');
    expect((await readBiometricSetting('ios', 1)).state).toBe('deferred');
    expect(await changeBiometrics(true, 1)).toBe('enabled');
    expect((await readBiometricSetting('ios', 1)).state).toBe('active');
    await deferBiometrics(1, 'offered'); // n'écrase jamais un choix actif
    expect((await resolveUnlockBiometry(1)).active).toBe(true);
    // Stockage : aucun mot de passe, jeton ni donnée biométrique — seulement l'état.
    const raw = sec.store.get(stateKey)!;
    expect(Object.keys(JSON.parse(raw).users['1']).sort()).toEqual(['at', 's', 'tok']);
  });

  it('multi-comptes : aucun choix transposable d’un compte à l’autre', async () => {
    installNative({ SecureStorage: fakeSecureStorage(), BiometricAuthNative: fakeBiometric() });
    expect(await changeBiometrics(true, 1)).toBe('enabled');
    expect((await resolveUnlockBiometry(2)).active).toBe(false);
    expect((await readBiometricSetting('ios', 2)).state).toBe('never');
    expect((await resolveUnlockBiometry(null)).active).toBe(false);
  });

  it('refus / annulation à l’activation : rien n’est enregistré', async () => {
    const sec = fakeSecureStorage();
    installNative({ SecureStorage: sec, BiometricAuthNative: fakeBiometric({ error: 'userCancel' }) });
    expect(await changeBiometrics(true, 1)).toBe('refused');
    expect(sec.store.has(stateKey)).toBe(false);
  });

  it('déconnexion volontaire : plus aucune réouverture par biométrie, pas de réactivation ni de reproposition', async () => {
    installNative({ SecureStorage: fakeSecureStorage(), BiometricAuthNative: fakeBiometric() });
    await changeBiometrics(true, 1);
    await changeBiometrics(true, 2);
    await clearBiometricsOnSignOut();
    expect((await resolveUnlockBiometry(1)).active).toBe(false);
    expect((await resolveUnlockBiometry(2)).active).toBe(false);
    const s = await readBiometricSetting('ios', 1);
    expect(s.state).toBe('deferred');
    expect(shouldOfferBiometrics({ featureOn: true, sessionStatus: 'authenticated', userId: 1, pathname: '/accueil', legalRequired: false, blocked: false, setting: s })).toBe(false);
    expect(nativeSignOutBiometrics()).toBe(clearBiometricsOnSignOut);
  });

  it('enrôlement modifié (visage / doigt ajouté) → « à réactiver », jusqu’à une réactivation explicite', async () => {
    let token = 'A'.repeat(64);
    const enrol = { enrollmentToken: vi.fn(async () => ({ token })) };
    installNative({ SecureStorage: fakeSecureStorage(), BiometricAuthNative: fakeBiometric(), VerebonaBiometricState: enrol });
    await changeBiometrics(true, 1);
    expect((await resolveUnlockBiometry(1)).active).toBe(true);
    token = 'B'.repeat(64);
    expect(await resolveUnlockBiometry(1)).toMatchObject({ active: false, reactivate: true });
    expect((await readBiometricSetting('ios', 1)).state).toBe('reactivate');
    token = 'A'.repeat(64); // même un retour à l'ancien enrôlement ne réactive pas tout seul
    expect((await resolveUnlockBiometry(1)).reactivate).toBe(true);
    expect(await changeBiometrics(true, 1)).toBe('enabled');
    expect((await resolveUnlockBiometry(1)).active).toBe(true);
  });

  it('binaire sans plugin d’enrôlement : fonctionne, empreinte adoptée dès qu’elle devient lisible', async () => {
    const sec = fakeSecureStorage();
    installNative({ SecureStorage: sec, BiometricAuthNative: fakeBiometric() });
    await changeBiometrics(true, 1);
    expect(JSON.parse(sec.store.get(stateKey)!).users['1'].tok).toBeNull();
    installNative({ SecureStorage: sec, BiometricAuthNative: fakeBiometric(), VerebonaBiometricState: { enrollmentToken: async () => ({ token: 'T1' }) } });
    expect((await resolveUnlockBiometry(1)).active).toBe(true);
    expect(JSON.parse(sec.store.get(stateKey)!).users['1'].tok).toBe('T1');
  });

  it('indisponible (biométrie retirée du téléphone, fonction coupée par le serveur)', async () => {
    const sec = fakeSecureStorage();
    installNative({ SecureStorage: sec, BiometricAuthNative: fakeBiometric() });
    await changeBiometrics(true, 1);
    installNative({ SecureStorage: sec, BiometricAuthNative: fakeBiometric({ available: false }) });
    expect(await resolveUnlockBiometry(1)).toMatchObject({ active: false, enabled: true, reactivate: false });
    expect((await readBiometricSetting('ios', 1)).state).toBe('unavailable');
    installNative({ SecureStorage: sec, BiometricAuthNative: fakeBiometric() });
    expect((await resolveUnlockBiometry(1, false)).active).toBe(false);
    expect((await readBiometricSetting('ios', 1, false)).state).toBe('unavailable');
    expect(effectiveBiometricState(null, { supported: false, available: true })).toBe('unavailable');
  });

  it('ancienne préférence d’appareil (lot 97B) : reprise une fois pour le compte connecté, puis effacée', async () => {
    const sec = fakeSecureStorage();
    installNative({ SecureStorage: sec, BiometricAuthNative: fakeBiometric() });
    await secureSet(SECURE_KEYS.biometricsEnabled, '1');
    expect((await resolveUnlockBiometry(5)).active).toBe(true);
    expect(sec.store.has(`${SECURE_PREFIX}${SECURE_KEYS.biometricsEnabled}`)).toBe(false);
    expect((await resolveUnlockBiometry(6)).active).toBe(false);
  });

  it('document abîmé : lu comme vide (jamais d’activation implicite)', () => {
    expect(parseBiometricDoc('{pas du json')).toEqual({ v: 1, users: {} });
    expect(parseBiometricDoc(JSON.stringify({ v: 1, users: { abc: { s: 'active' }, 3: { s: 'bogus' }, 4: { s: 'active', at: 'x' } } })).users)
      .toEqual({ 4: { s: 'active', at: 'x' } });
  });

  it('Web / PWA : non pris en charge, aucun nettoyage natif', async () => {
    installWeb();
    expect((await readBiometricSetting(null, 1)).supported).toBe(false);
    expect(nativeSignOutBiometrics()).toBeUndefined();
    expect(await verifyUserDetailed({ biometryOnly: true, reason: 'x' })).toBe('unavailable');
  });

  it('vérification détaillée : erreurs du plugin, options de la fenêtre système', async () => {
    const bio = fakeBiometric({ error: 'biometryLockout' });
    installNative({ BiometricAuthNative: bio });
    expect(await verifyUserDetailed({ biometryOnly: true, reason: 'Déverrouiller Verebona' })).toBe('lockout');
    expect(bio.internalAuthenticate).toHaveBeenCalledWith(expect.objectContaining({ allowDeviceCredential: false, iosFallbackTitle: '' }));
  });
});

// ── L107A-OFFR ──────────────────────────────────────────────────────────────

describe('L107A-OFFR — proposition unique après connexion', () => {
  const ok = { supported: true, available: true, state: 'never' as const };
  const base = { featureOn: true, sessionStatus: 'authenticated', userId: 1, pathname: '/accueil', legalRequired: false, blocked: false, setting: ok };

  it('proposée seulement : session établie, écran de l’app, biométrie configurée, jamais proposée', () => {
    expect(shouldOfferBiometrics(base)).toBe(true);
    expect(shouldOfferBiometrics({ ...base, sessionStatus: 'checking' })).toBe(false);
    expect(shouldOfferBiometrics({ ...base, sessionStatus: 'unauthenticated' })).toBe(false); // connexion infructueuse
    expect(shouldOfferBiometrics({ ...base, userId: null })).toBe(false);
    expect(shouldOfferBiometrics({ ...base, pathname: '/login' })).toBe(false);
    expect(shouldOfferBiometrics({ ...base, pathname: '/signup' })).toBe(false); // inscription non finalisée
    expect(shouldOfferBiometrics({ ...base, pathname: '/verify-email' })).toBe(false);
    expect(shouldOfferBiometrics({ ...base, pathname: '/cguv' })).toBe(false);
    expect(shouldOfferBiometrics({ ...base, legalRequired: true })).toBe(false); // consentement obligatoire d'abord
    expect(shouldOfferBiometrics({ ...base, blocked: true })).toBe(false); // verrou / écran bloquant
    expect(shouldOfferBiometrics({ ...base, featureOn: false })).toBe(false);
    expect(shouldOfferBiometrics({ ...base, setting: { ...ok, available: false } })).toBe(false);
    expect(shouldOfferBiometrics({ ...base, setting: { ...ok, state: 'deferred' } })).toBe(false);
    expect(shouldOfferBiometrics({ ...base, setting: { ...ok, state: 'active' } })).toBe(false);
    expect(shouldOfferBiometrics({ ...base, setting: null })).toBe(false);
    expect(isBiometricOfferPath('/documents/12')).toBe(true);
    expect(isBiometricOfferPath('/accueilx')).toBe(false);
  });

  it('textes adaptés à l’appareil', () => {
    expect(biometricOfferTitle(2)).toBe('Activer Face ID pour les prochaines connexions ?');
    expect(biometricOfferTitle(1)).toBe('Activer Touch ID ?');
    expect(biometricOfferTitle(3)).toBe('Activer la biométrie ?');
    expect(BIOMETRIC_OFFER_DESCRIPTION).toBe('Déverrouillez Verebona plus rapidement sur cet appareil. Vous pourrez désactiver cette option dans Mon compte.');
  });
});

// ── L107A-BOOT ──────────────────────────────────────────────────────────────

describe('L107A-BOOT — masquage avant tout rendu au démarrage à froid', () => {
  function run(o: { native: boolean; backgroundAt: number | null; now: number }) {
    const attrs = new Map<string, string>();
    const body: unknown[] = [];
    const doc = {
      documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v), getAttribute: (k: string) => attrs.get(k) ?? null },
      getElementById: () => null,
      createElement: () => ({ setAttribute() {}, id: '', type: '', textContent: '', onclick: null }),
      body: { appendChild: (n: unknown) => body.push(n) },
    };
    const win = o.native ? { Capacitor: { isNativePlatform: () => true } } : {};
    const storage = { getItem: (k: string) => (k === BACKGROUND_AT_KEY && o.backgroundAt !== null ? String(o.backgroundAt) : null) };
    vi.useFakeTimers({ now: o.now });
    new Function('window', 'document', 'localStorage', nativeLockBootScript())(win, doc, storage);
    return { attrs, body, attrsAfterRescue: () => { vi.advanceTimersByTime(20_000); return body.length; } };
  }
  afterEach(() => { vi.useRealTimers(); });

  it('app native relancée après 5 min : masque posé', () => {
    expect(run({ native: true, backgroundAt: T0 - 6 * MIN, now: T0 }).attrs.get(LOCK_ATTRIBUTE)).toBe('boot');
    expect(run({ native: true, backgroundAt: T0 + MIN, now: T0 }).attrs.get(LOCK_ATTRIBUTE)).toBe('boot'); // horloge reculée
  });

  it('< 5 min, aucun passage en arrière-plan, navigateur / PWA : rien', () => {
    expect(run({ native: true, backgroundAt: T0 - 4 * MIN, now: T0 }).attrs.size).toBe(0);
    expect(run({ native: true, backgroundAt: null, now: T0 }).attrs.size).toBe(0);
    expect(run({ native: false, backgroundAt: T0 - 60 * MIN, now: T0 }).attrs.size).toBe(0);
  });

  it('filet : bouton « Recharger » si le module natif ne reprend pas la main (contenu jamais révélé)', () => {
    const r = run({ native: true, backgroundAt: T0 - 6 * MIN, now: T0 });
    expect(r.attrsAfterRescue()).toBe(1);
    expect(r.attrs.get(LOCK_ATTRIBUTE)).toBe('boot');
  });
});

// ── L107A-SRC ───────────────────────────────────────────────────────────────

describe('L107A-SRC — interface et coque native', () => {
  it('écran statique « Verebona est verrouillé » et bouton préalable retirés du parcours', () => {
    const runtime = read('src/components/native/NativeBridgeRuntime.tsx');
    const screen = read('src/components/native/NativeUnlockScreen.tsx');
    for (const src of [runtime, screen]) {
      expect(src).not.toMatch(/Verebona est verrouillé/);
      expect(src).not.toMatch(/se verrouille après 5 minutes/);
      expect(src).not.toMatch(/>\s*Déverrouiller\s*</);
    }
    expect(runtime).toMatch(/useNativeUnlock\(featuresRef\)/);
    expect(screen).toMatch(/role="alertdialog"/);
    expect(screen).toMatch(/aria-describedby/);
  });

  it('jamais présentée comme une double authentification', () => {
    for (const f of ['src/components/native/BiometricOfferCard.tsx', 'src/components/account/security/BiometricsBlock.tsx', 'src/lib/native/biometric-consent.ts']) {
      const visible = read(f).split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      expect(visible, f).not.toMatch(/double authentification|MFA|2FA/i);
    }
  });

  it('déconnexion : nettoyage biométrique sauf « Se reconnecter » depuis l’écran de secours', () => {
    const api = read('src/lib/api-client.ts');
    expect(api).toMatch(/opts\.keepBiometrics \? undefined : nativeSignOutBiometrics\(\)/);
    expect(read('src/components/native/useNativeUnlock.ts')).toMatch(/signOut\(\{ keepBiometrics: true \}\)/);
  });

  it('script de démarrage chargé dans le layout racine', () => {
    expect(read('src/app/layout.tsx')).toMatch(/nativeLockBootScript\(\)/);
    expect(read('src/app/globals.css')).toMatch(/html\[data-vb-lock\] body > \*:not\(\[data-vb-lock-screen\]\)/);
  });

  it('coque iOS / Android : plugin local d’enrôlement enregistré, justification Face ID, aperçu masqué', () => {
    const pbx = read('mobile/ios/App/App.xcodeproj/project.pbxproj');
    expect(pbx).toMatch(/VerebonaBiometricState\.swift in Sources/);
    expect(read('mobile/ios/App/App/VerebonaBridgeViewController.swift')).toMatch(/VerebonaBiometricStatePlugin\(\)/);
    expect(read('mobile/ios/App/App/VerebonaBiometricState.swift')).toMatch(/jsName = "VerebonaBiometricState"/);
    expect(read('mobile/android/app/src/main/java/fr/verebona/app/MainActivity.java')).toMatch(/registerPlugin\(VerebonaBiometricStatePlugin\.class\)/);
    const java = read('mobile/android/app/src/main/java/fr/verebona/app/VerebonaBiometricStatePlugin.java');
    expect(java).toMatch(/setInvalidatedByBiometricEnrollment\(true\)/);
    expect(java).toMatch(/@CapacitorPlugin\(name = "VerebonaBiometricState"\)/);
    expect(read('mobile/ios/App/App/Info.plist')).toMatch(/<key>NSFaceIDUsageDescription<\/key>\s*<string>[^<]*Face ID[^<]*<\/string>/);
    expect(read('mobile/capacitor.config.ts')).toMatch(/PrivacyScreen: \{ enable: true/);
  });
});
