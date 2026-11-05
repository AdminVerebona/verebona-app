/**
 * Lot 111D — anomalie de recette #642 bis : écran « Déverrouiller Verebona »
 * (« Utiliser le code du téléphone » / « Se reconnecter ») affiché à la place
 * de la fenêtre Face ID à la reprise.
 *
 *   L111D-CAUSE  reconstitution du cas de la capture (lu SANS identité, lu en
 *                arrière-plan) : avant / après correction ;
 *   L111D-MACH   machine d'états pure + contrôleur, tous les cas du ticket ;
 *   L111D-CONS   lecture du choix biométrique : échec ≠ « non activé », aucune
 *                écriture sur une lecture en échec ;
 *   L111D-LOG    journal technique sans donnée biométrique ni identifiant ;
 *   L111D-VIEW   rendu de l'écran de secours (libellés adaptés à l'appareil) ;
 *   L111D-SRC    câblage (premier plan, visibilité, MFA) et périmètre (modale
 *                de proposition 111G non modifiée).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { retryLabel, type PromptOutcome } from '@/lib/native/app-lock';
import { changeBiometrics, deferBiometrics, resolveUnlockBiometry } from '@/lib/native/biometric-consent';
import { SECURE_KEYS, SECURE_PREFIX } from '@/lib/native/secure-store';
import { createUnlockController, type UnlockDeps } from '@/lib/native/unlock-controller';
import {
  IDENTITY_WAIT_MS, INITIAL_UNLOCK_STATE, fallbackMessage, reduceUnlock, unlockSessionStatus,
  type SessionKnown, type UnlockEvent, type UnlockMethod, type UnlockState,
} from '@/lib/native/unlock-machine';
import {
  UNLOCK_JOURNAL_KEY, UNLOCK_JOURNAL_MAX, appendUnlockJournal, readUnlockJournal, sanitizeUnlockDetail,
} from '@/lib/native/unlock-journal';
import { MFA_REQUIRED_MESSAGE } from '@/lib/auth/mfa/constants';

(globalThis as { React?: typeof React }).React = React;
const { UnlockFallbackView, fallbackActionVariant } = await import('@/components/native/NativeUnlockScreen');

const ROOT = resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 4, 21, 24, 0);

const BIO_ON: UnlockMethod = { biometry: true, biometryAvailable: true, deviceSecure: true };
const NOT_ENABLED: UnlockMethod = { biometry: false, biometryAvailable: true, deviceSecure: true, whyNot: 'not_enabled' };

function run(events: UnlockEvent[], from: UnlockState = INITIAL_UNLOCK_STATE) {
  let s = from;
  const effects: Array<{ type: string } & Record<string, unknown>> = [];
  for (const e of events) {
    const t = reduceUnlock(s, e);
    s = t.state;
    effects.push(...t.effects);
  }
  return { s, effects, types: effects.map((x) => x.type) };
}

function deferred<T>() {
  let resolveFn!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolveFn = r; });
  return { promise, resolve: resolveFn };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

function harness(o: { backgroundAt?: number | null; method?: UnlockMethod; verify?: { status: SessionKnown; userId: number | null }; foreground?: boolean } = {}) {
  let clock = T0;
  let bg: number | null = o.backgroundAt ?? null;
  let covered = false;
  const prompts: Array<{ mode: string; d: ReturnType<typeof deferred<PromptOutcome>> }> = [];
  const timers: Array<{ ms: number; fn: () => void }> = [];
  const logs: Array<{ code: string; detail?: Record<string, unknown> }> = [];
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
    isForeground: () => o.foreground ?? true,
    setTimer: (ms: number, fn: () => void) => { timers.push({ ms, fn }); },
    log: (code: string, detail?: Record<string, unknown>) => { logs.push({ code, detail }); },
  } satisfies UnlockDeps;
  const c = createUnlockController(deps);
  return {
    c, deps, prompts, timers, logs,
    get covered() { return covered; },
    get bg() { return bg; },
    advance(ms: number) { clock += ms; },
    setMethod(m: UnlockMethod) { method = m; },
    setVerify(v: { status: SessionKnown; userId: number | null }) { verify = v; },
    session(status: SessionKnown, userId: number | null = 1) { c.dispatch({ type: 'SESSION', status, userId }); },
    phase: () => c.getState().phase,
    fallback: () => c.getState().fallback,
  };
}

// ── L111D-CAUSE ─────────────────────────────────────────────────────────────

describe('L111D-CAUSE — cas de la capture reconstitué', () => {
  it('démarrage à froid / vue rechargée, /api/users/me en échec momentané : plus de lecture « sans compte » ni d’écran « non activé »', async () => {
    const h = harness({ backgroundAt: T0 - 30 * MIN });
    h.c.boot();
    expect(h.covered).toBe(true);
    // Magasin de session : « momentanément indisponible », AUCUNE identité (premier chargement).
    h.session('temporarily-unavailable', null);
    await flush();
    // Avant 111D : readMethod(null) → « not_enabled » → écran de la capture, définitif.
    expect(h.deps.readMethod).not.toHaveBeenCalled();
    expect(h.phase()).toBe('pending');
    expect(h.fallback()).toBeNull();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(IDENTITY_WAIT_MS);
    // Le réseau revient (relecture sur `online` / `visibilitychange`) : Face ID immédiatement.
    h.session('authenticated', 1);
    await flush();
    expect(h.deps.readMethod).toHaveBeenCalledWith(1);
    expect(h.prompts.map((p) => p.mode)).toEqual(['biometry']);
    h.timers[0].fn(); // délai écoulé après coup : ignoré
    expect(h.phase()).toBe('prompting');
    h.prompts[0].d.resolve('ok'); await flush();
    expect(h.phase()).toBe('unlocked');
    expect(h.covered).toBe(false);
  });

  it('vue rechargée app EN ARRIÈRE-PLAN (téléphone verrouillé) : rien n’est lu ni demandé avant le retour au premier plan', async () => {
    const h = harness({ backgroundAt: T0 - 30 * MIN, foreground: false });
    h.c.boot();
    h.session('authenticated', 1);
    await flush();
    // Avant 111D : Keychain lu téléphone verrouillé (iOS rend « absent ») → « non activé »,
    // ou fenêtre Face ID refusée (« interrompu ») ; la reprise suivante était ignorée.
    expect(h.deps.readMethod).not.toHaveBeenCalled();
    expect(h.deps.prompt).not.toHaveBeenCalled();
    expect(h.covered).toBe(true);
    h.c.resume(); await flush();
    expect(h.deps.readMethod).toHaveBeenCalledTimes(1);
    expect(h.prompts).toHaveLength(1);
    expect(h.fallback()).toBeNull(); // aucun écran avant Face ID
  });

  it('sonde de démarrage « arrière-plan » (état natif) : même politique ; réponse périmée ignorée', async () => {
    const h = harness({ backgroundAt: T0 - 30 * MIN });
    h.c.boot();
    h.c.backgroundProbe();
    h.session('authenticated', 1); await flush();
    expect(h.deps.prompt).not.toHaveBeenCalled();
    h.c.resume(); await flush();
    expect(h.deps.prompt).toHaveBeenCalledTimes(1);
    // Sonde arrivée APRÈS un vrai événement de cycle de vie : sans effet.
    h.c.backgroundProbe(); h.c.resume(); await flush();
    expect(h.deps.prompt).toHaveBeenCalledTimes(1);
  });

  it('vue rechargée en arrière-plan SANS verrou dû : le départ est enregistré, la règle des 5 min s’applique au retour', async () => {
    const h = harness();
    h.c.boot(); h.session('authenticated', 1); await flush();
    h.c.backgroundProbe();
    expect(h.covered).toBe(true);
    expect(h.deps.persistBackgroundAt).toHaveBeenCalledWith(T0);
    h.advance(20 * MIN); h.c.resume(); await flush();
    expect(h.deps.prompt).toHaveBeenCalledTimes(1);
  });
});

// ── L111D-MACH ──────────────────────────────────────────────────────────────

describe('L111D-MACH — comportement cible du ticket (machine pure + contrôleur)', () => {
  it('< 5 min : dernier écran, aucune demande ; ≥ 5 min : Face ID immédiat, sans écran préalable', async () => {
    const h = harness();
    h.c.boot(); h.session('authenticated', 1); await flush();
    h.c.background(); h.advance(4 * MIN + 59_000); h.c.resume(); await flush();
    expect(h.phase()).toBe('unlocked');
    expect(h.deps.readMethod).not.toHaveBeenCalled();
    h.c.background(); h.advance(5 * MIN); h.c.resume();
    await flush();
    const phases = h.logs.filter((l) => l.code === 'UNLOCK_PHASE').map((l) => l.detail?.to);
    expect(phases).not.toContain('fallback');
    expect(h.prompts.map((p) => p.mode)).toEqual(['biometry']);
    h.prompts[0].d.resolve('ok'); await flush();
    expect(h.phase()).toBe('unlocked');
    expect(h.deps.navigate).not.toHaveBeenCalled(); // dernier écran conservé
    expect(h.deps.signInAgain).not.toHaveBeenCalled();
  });

  it('échec / annulation : « Réessayer », code du téléphone (API système), reconnexion en dernier ; aucune boucle', async () => {
    for (const outcome of ['failed', 'cancelled'] as const) {
      const h = harness({ backgroundAt: T0 - 10 * MIN });
      h.c.boot(); h.session('authenticated', 1); await flush();
      h.prompts[0].d.resolve(outcome); await flush();
      expect(h.fallback()).toMatchObject({ reason: outcome, actions: ['retry_biometry', 'device_credential', 'sign_in'] });
      // Retours de la fenêtre système (inactive → active), visibilité : pas de nouvelle fenêtre.
      h.c.resume(); h.c.resume(); await flush();
      expect(h.deps.prompt).toHaveBeenCalledTimes(1);
      h.c.dispatch({ type: 'DEVICE_CREDENTIAL' }); await flush();
      expect(h.prompts[1].mode).toBe('device_credential');
      h.prompts[1].d.resolve('ok'); await flush();
      expect(h.phase()).toBe('unlocked');
    }
  });

  it('téléphone sans code : « Réessayer » et « Se reconnecter » seulement', async () => {
    const h = harness({ backgroundAt: T0 - 10 * MIN, method: { biometry: true, biometryAvailable: false, deviceSecure: false } });
    h.c.boot(); h.session('authenticated', 1); await flush();
    h.prompts[0].d.resolve('failed'); await flush();
    expect(h.fallback()?.actions).toEqual(['retry_biometry', 'sign_in']);
  });

  it('interruption système (appel, centre de contrôle) : UNE nouvelle fenêtre au retour, pas deux', async () => {
    const h = harness({ backgroundAt: T0 - 10 * MIN });
    h.c.boot(); h.session('authenticated', 1); await flush();
    h.prompts[0].d.resolve('interrupted'); await flush();
    expect(h.fallback()?.reason).toBe('interrupted');
    h.c.resume(); await flush();
    expect(h.deps.prompt).toHaveBeenCalledTimes(2);
    h.prompts[1].d.resolve('interrupted'); await flush();
    h.c.resume(); h.c.resume(); await flush();
    expect(h.deps.prompt).toHaveBeenCalledTimes(2);
    expect(h.fallback()?.actions).toContain('retry_biometry');
  });

  it('blocage / indisponibilité : code du téléphone et reconnexion, pas de « Réessayer »', () => {
    for (const outcome of ['lockout', 'unavailable'] as const) {
      const { s } = run([
        { type: 'BOOT', now: T0, backgroundAt: T0 - 10 * MIN },
        { type: 'SESSION', status: 'authenticated', userId: 1 },
        { type: 'METHOD', userId: 1, method: BIO_ON },
      ]);
      const r = reduceUnlock(s, { type: 'PROMPT_RESULT', attempt: s.attempt, outcome }).state;
      expect(r.fallback?.actions).toEqual(['device_credential', 'sign_in']);
      expect(reduceUnlock(r, { type: 'RETRY' }).effects).toEqual([]);
    }
  });

  it('biométrie non activée (choix respecté) : écran sobre, aucune fenêtre automatique, alternative accessible', () => {
    const { s, types } = run([
      { type: 'BOOT', now: T0, backgroundAt: T0 - 10 * MIN },
      { type: 'SESSION', status: 'authenticated', userId: 1 },
      { type: 'METHOD', userId: 1, method: NOT_ENABLED },
    ]);
    expect(types).not.toContain('prompt');
    expect(s.fallback).toMatchObject({ reason: 'not_enabled', actions: ['device_credential', 'sign_in'] });
    expect(fallbackMessage(s.fallback!, 'Face ID')).not.toMatch(/Face ID/);
  });

  it('identité jamais obtenue : écran « connexion impossible » après le délai, « Réessayer » relit la session ; identité arrivée → Face ID', async () => {
    const h = harness({ backgroundAt: T0 - 10 * MIN, verify: { status: 'temporarily-unavailable', userId: null } });
    h.c.boot(); h.session('temporarily-unavailable', null); await flush();
    h.timers[0].fn();
    expect(h.fallback()).toMatchObject({ reason: 'session_unavailable', actions: ['retry_session', 'sign_in'] });
    expect(h.covered).toBe(true);
    h.c.dispatch({ type: 'RETRY_SESSION' }); await flush();
    expect(h.deps.verifySession).toHaveBeenCalledTimes(1);
    expect(h.timers).toHaveLength(2);
    h.timers[1].fn();
    expect(h.fallback()?.reason).toBe('session_unavailable');
    h.session('authenticated', 1); await flush();
    expect(h.prompts).toHaveLength(1);
  });

  it('session serveur expirée / révoquée : vraie reconnexion (sortie de session), jamais contournée par Face ID', async () => {
    const h = harness({ verify: { status: 'unauthenticated', userId: null } });
    h.c.boot(); h.session('authenticated', 1); await flush();
    h.c.background(); h.advance(6 * MIN); h.c.resume(); await flush();
    h.prompts[0]?.d.resolve('ok'); await flush();
    expect(h.deps.exitSession).toHaveBeenCalledTimes(1);
    // Le seuil local n'est jamais une expiration serveur : session valide → aucune sortie.
    const k = harness();
    k.c.boot(); k.session('authenticated', 1); await flush();
    k.c.background(); k.advance(60 * MIN); k.c.resume(); await flush();
    k.prompts[0].d.resolve('ok'); await flush();
    expect(k.deps.exitSession).not.toHaveBeenCalled();
    expect(k.deps.signInAgain).not.toHaveBeenCalled();
  });

  it('double authentification exigée (110B, 403 MFA_REQUIRED) : reconnexion réelle, Face ID ne suffit pas', async () => {
    expect(unlockSessionStatus('temporarily-unavailable', 'MFA_REQUIRED')).toBe('reauth-required');
    expect(unlockSessionStatus('temporarily-unavailable', 'REQUEST_TIMEOUT')).toBe('temporarily-unavailable');
    expect(unlockSessionStatus('authenticated', null)).toBe('authenticated');
    // Reprise : session relue → refus MFA, même si Face ID réussit.
    const h = harness({ verify: { status: 'reauth-required', userId: 1 } });
    h.c.boot(); h.session('authenticated', 1); await flush();
    h.c.background(); h.advance(6 * MIN); h.c.resume(); await flush();
    expect(h.fallback()).toMatchObject({ reason: 'sign_in_required', actions: ['sign_in'] });
    h.c.dispatch({ type: 'SIGN_IN' });
    expect(h.deps.signInAgain).toHaveBeenCalledWith(null, 'mfa_required');
    expect(fallbackMessage({ reason: 'sign_in_required', mode: 'biometry' }, 'Face ID')).toBe(MFA_REQUIRED_MESSAGE);
    // Démarrage à froid avec refus MFA : aucune fenêtre biométrique.
    const { s, types } = run([
      { type: 'BOOT', now: T0, backgroundAt: T0 - 10 * MIN },
      { type: 'SESSION', status: 'reauth-required', userId: null },
    ]);
    expect(types).not.toContain('prompt');
    expect(types).not.toContain('read_method');
    expect(s.fallback?.reason).toBe('sign_in_required');
  });

  it('démarrage à froid / lien profond : même politique, contenu masqué, destination ouverte APRÈS Face ID', async () => {
    const h = harness({ backgroundAt: T0 - 30 * MIN, foreground: false });
    h.c.boot();
    expect(h.covered).toBe(true);
    h.c.dispatch({ type: 'NAVIGATE', path: '/documents/42' });
    h.session('authenticated', 1); await flush();
    h.c.resume(); await flush();
    expect(h.deps.navigate).not.toHaveBeenCalled();
    h.prompts[0].d.resolve('ok'); await flush();
    expect(h.deps.navigate).toHaveBeenCalledWith('/documents/42');
  });

  it('reprise signalée deux fois (cycle de vie natif + visibilité) : une seule fenêtre', async () => {
    const h = harness();
    h.c.boot(); h.session('authenticated', 1); await flush();
    h.c.background(); h.advance(6 * MIN);
    h.c.resume(); h.c.resume(); await flush();
    h.c.background(); h.c.resume(); await flush(); // fenêtre système : inactive → active
    expect(h.deps.prompt).toHaveBeenCalledTimes(1);
  });

  it('changement de compte pendant l’attente de l’identité : moyen du compte servi par le serveur', async () => {
    const h = harness({ backgroundAt: T0 - 10 * MIN });
    h.c.boot(); h.session('temporarily-unavailable', null); await flush();
    h.session('authenticated', 7); await flush();
    expect(h.deps.readMethod).toHaveBeenCalledWith(7);
    expect(h.deps.readMethod).not.toHaveBeenCalledWith(null);
  });
});

// ── L111D-CONS ──────────────────────────────────────────────────────────────

function fakeSecureStorage() {
  const store = new Map<string, string>();
  const plugin = {
    store,
    failReads: false,
    internalGetItem: vi.fn(async ({ prefixedKey }: { prefixedKey: string }) => {
      if (plugin.failReads) throw Object.assign(new Error('keystore'), { code: 'osError' });
      return { data: store.get(prefixedKey) ?? null };
    }),
    internalSetItem: vi.fn(async ({ prefixedKey, data }: { prefixedKey: string; data: string }) => { store.set(prefixedKey, data); }),
    internalRemoveItem: vi.fn(async ({ prefixedKey }: { prefixedKey: string }) => ({ success: store.delete(prefixedKey) })),
    internalClearItemsWithPrefix: vi.fn(async () => { store.clear(); }),
  };
  return plugin;
}
let sec: ReturnType<typeof fakeSecureStorage>;

function fakeBiometric() {
  return {
    checkBiometry: vi.fn(async () => ({ isAvailable: true, deviceIsSecure: true, biometryType: 2 })),
    internalAuthenticate: vi.fn(async () => undefined),
  };
}

function installNative(plugins: Record<string, unknown>) {
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: plugins },
    location: { protocol: 'https:', origin: 'https://app.preprod.verebona.fr', pathname: '/accueil', search: '' },
  }));
}

const stateKey = `${SECURE_PREFIX}${SECURE_KEYS.biometricsState}`;

describe('L111D-CONS — lecture du choix biométrique', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('lecture en échec (Keystore) : « lecture impossible », jamais « non activé » ; aucune écriture écrasante', async () => {
    sec = fakeSecureStorage();
    installNative({ SecureStorage: sec, BiometricAuthNative: fakeBiometric() });
    expect(await changeBiometrics(true, 1)).toBe('enabled');
    expect(await resolveUnlockBiometry(1)).toMatchObject({ active: true, stored: 'active' });
    sec.failReads = true;
    expect(await resolveUnlockBiometry(1)).toMatchObject({ active: false, enabled: false, stored: 'read_failed' });
    await deferBiometrics(2, 'offered');
    sec.failReads = false;
    const doc = JSON.parse(sec.store.get(stateKey)!);
    expect(doc.users['1'].s).toBe('active'); // le choix du compte 1 n'a pas été écrasé
    expect(doc.users['2']).toBeUndefined();
  });

  it('compte inconnu : code « no_user » (diagnostic) ; jamais proposé : « never » ; plugin d’enrôlement détecté', async () => {
    sec = fakeSecureStorage();
    installNative({ SecureStorage: sec, BiometricAuthNative: fakeBiometric() });
    expect(await resolveUnlockBiometry(null)).toMatchObject({ active: false, stored: 'no_user', enrollmentPlugin: false });
    expect(await resolveUnlockBiometry(3)).toMatchObject({ active: false, enabled: false, stored: 'never' });
    installNative({ SecureStorage: sec, BiometricAuthNative: fakeBiometric(), VerebonaBiometricState: { enrollmentToken: async () => ({ token: 'T' }) } });
    expect((await resolveUnlockBiometry(3)).enrollmentPlugin).toBe(true);
  });
});

// ── L111D-LOG ───────────────────────────────────────────────────────────────

describe('L111D-LOG — journal technique sans donnée biométrique', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('liste fermée de champs : ni identifiant, ni chemin, ni empreinte', () => {
    const d = sanitizeUnlockDetail({
      to: 'fallback', reason: 'not_enabled', stored: 'never', userId: 12, email: 'a@b.fr', path: '/documents/9', tok: 'abc', token: 'x',
      returnPath: '/x', outcome: 'cancelled', attempt: 3, foreground: true,
    });
    expect(d).toEqual({ to: 'fallback', reason: 'not_enabled', stored: 'never', outcome: 'cancelled', attempt: 3, foreground: true });
  });

  it('anneau de 40 entrées dans le stockage local ; stockage absent : sans erreur', () => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } });
    for (let i = 0; i < UNLOCK_JOURNAL_MAX + 5; i++) appendUnlockJournal('UNLOCK_PHASE', { attempt: i }, T0 + i);
    const list = readUnlockJournal();
    expect(list).toHaveLength(UNLOCK_JOURNAL_MAX);
    expect(list[0].d.attempt).toBe(5);
    expect(mem.has(UNLOCK_JOURNAL_KEY)).toBe(true);
    appendUnlockJournal('bad code with spaces', {});
    expect(readUnlockJournal()).toHaveLength(UNLOCK_JOURNAL_MAX);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(() => appendUnlockJournal('UNLOCK_BOOT', {})).not.toThrow();
    expect(readUnlockJournal()).toEqual([]);
  });

  it('contrôleur : chaque décision est tracée (démarrage, moyen lu, fenêtre, résultat, motif du secours)', async () => {
    const h = harness({ backgroundAt: T0 - 10 * MIN, method: { ...BIO_ON, diag: { stored: 'active', type: 2 } } });
    h.c.boot(); h.session('authenticated', 1); await flush();
    h.prompts[0].d.resolve('cancelled'); await flush();
    const codes = h.logs.map((l) => l.code);
    expect(codes).toEqual(expect.arrayContaining(['UNLOCK_BOOT', 'UNLOCK_METHOD', 'UNLOCK_PROMPT', 'UNLOCK_PROMPT_RESULT', 'UNLOCK_PHASE']));
    expect(h.logs.find((l) => l.code === 'UNLOCK_METHOD')?.detail).toMatchObject({ biometry: true, stored: 'active' });
    expect(h.logs.filter((l) => l.code === 'UNLOCK_PHASE').at(-1)?.detail).toMatchObject({ to: 'fallback', reason: 'cancelled' });
    for (const l of h.logs) expect(JSON.stringify(l.detail ?? {})).not.toMatch(/userId|"tok"|token/);
  });
});

// ── L111D-VIEW ──────────────────────────────────────────────────────────────

describe('L111D-VIEW — rendu de l’écran de secours', () => {
  const render = (fallback: Parameters<typeof UnlockFallbackView>[0]['fallback'], short = 'Face ID', retry = 'Réessayer Face ID') =>
    renderToStaticMarkup(h(UnlockFallbackView, { fallback, shortLabel: short, retryLabel: retry, onAction: () => {} }));

  it('après un échec Face ID : « Réessayer Face ID » en principal, puis code du téléphone, reconnexion discrète', () => {
    const html = render({ reason: 'cancelled', mode: 'biometry', actions: ['retry_biometry', 'device_credential', 'sign_in'] });
    expect(html).toMatch(/role="alertdialog"/);
    expect(html).toMatch(/Déverrouiller Verebona/);
    expect(html).toMatch(/Vérification annulée\./);
    const labels = [...html.matchAll(/data-action="([a-z_]+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]]);
    expect(labels).toEqual([
      ['retry_biometry', 'Réessayer Face ID'],
      ['device_credential', 'Utiliser le code du téléphone'],
      ['sign_in', 'Se reconnecter'],
    ]);
    expect(fallbackActionVariant('retry_biometry', 0, 3)).toBe('default');
    expect(fallbackActionVariant('device_credential', 1, 3)).toBe('outline');
    expect(fallbackActionVariant('sign_in', 2, 3)).toBe('ghost');
    expect(fallbackActionVariant('sign_in', 1, 2)).toBe('outline');
  });

  it('libellé adapté au dispositif : Touch ID, biométrie Android', () => {
    expect(render({ reason: 'failed', mode: 'biometry', actions: ['retry_biometry', 'sign_in'] }, 'Touch ID', retryLabel(1, 'ios'))).toMatch(/Réessayer Touch ID/);
    const android = render({ reason: 'failed', mode: 'biometry', actions: ['retry_biometry', 'sign_in'] }, 'la biométrie', retryLabel(null, 'android'));
    expect(android).toMatch(/Réessayer avec la biométrie/);
    expect(android).toMatch(/La biométrie n’a pas abouti\./);
  });

  it('non activée, connexion impossible, reconnexion exigée : textes sobres, une issue toujours présente', () => {
    expect(render({ reason: 'not_enabled', mode: 'device_credential', actions: ['device_credential', 'sign_in'] })).toMatch(/Confirmez qu’il s’agit bien de vous/);
    const offline = render({ reason: 'session_unavailable', mode: 'biometry', actions: ['retry_session', 'sign_in'] });
    expect(offline).toMatch(/Connexion au service impossible/);
    expect(offline).toMatch(/>Réessayer</);
    const mfa = render({ reason: 'sign_in_required', mode: 'biometry', actions: ['sign_in'] });
    expect(mfa).toMatch(/confirmez votre identité avec votre méthode de sécurité/);
    expect(mfa).not.toMatch(/Face ID/);
    for (const html of [offline, mfa]) expect(html).not.toMatch(/5 minutes/);
  });
});

// ── L111D-SRC ───────────────────────────────────────────────────────────────

describe('L111D-SRC — câblage et périmètre', () => {
  it('hook : premier plan au démarrage (visibilité + App.getState), reprise sur visibilitychange, MFA distinguée, journal', () => {
    const src = read('src/components/native/useNativeUnlock.ts');
    expect(src).toMatch(/isForeground: pageVisible/);
    expect(src).toMatch(/app\.getState\(\)/);
    expect(src).toMatch(/controller\.backgroundProbe\(\)/);
    expect(src).toMatch(/addEventListener\('visibilitychange'/);
    expect(src).toMatch(/unlockSessionStatus\(status, sessionError\?\.code\)/);
    expect(src).toMatch(/unlockSessionStatus\(snap\.status, snap\.error\?\.code\)/);
    expect(src).toMatch(/appendUnlockJournal\(code, detail\)/);
    expect(src).toMatch(/r\.stored === 'read_failed'/);
    expect(src).toMatch(/reason=mfa_required/);
  });

  it('une seule logique : la machine 107A est corrigée, pas doublée ; modale de proposition (111G) non touchée', () => {
    const runtime = read('src/components/native/NativeBridgeRuntime.tsx');
    expect(runtime.match(/useNativeUnlock\(/g)).toHaveLength(1);
    expect(read('src/components/native/BiometricOfferCard.tsx')).not.toMatch(/unlock-machine|111D/);
    expect(read('src/components/native/useBiometricOffer.ts')).not.toMatch(/111D/);
    for (const f of ['src/lib/native/unlock-machine.ts', 'src/lib/native/unlock-controller.ts']) {
      expect(read(f)).not.toMatch(/localStorage|document\.|window\./); // modules purs (hors commentaires inclus)
    }
  });

  it('compatibilité binaires : aucun nouveau plugin natif requis (App, BiometricAuthNative, SecureStorage existent depuis le lot 95)', () => {
    const src = read('src/components/native/useNativeUnlock.ts') + read('src/lib/native/unlock-journal.ts');
    const plugins = [...src.matchAll(/NATIVE_PLUGINS\.([a-zA-Z]+)/g)].map((m) => m[1]);
    expect(new Set(plugins)).toEqual(new Set(['app', 'biometric', 'secureStorage', 'biometricState']));
    // `biometricState` n'est lu que pour le journal (présence) : absent des anciens binaires sans effet.
    expect(read('mobile/package.json')).toMatch(/"@capacitor\/app"/);
  });
});
