/**
 * Autorisations de première connexion mobile — lot 113J (décision PO du
 * 06/11/2026 : « une seule décision par autorisation = la demande NATIVE »).
 * Remplace les fenêtres Verebona de proposition des lots 107A / 109G / 111G /
 * 111T (BiometricOfferCard, PushOnboardingCard, NativeOfferDialog et leur
 * orchestration `biometric-offer-flow`) : AUCUNE fenêtre, AUCUN toast ici.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POINT DE DÉCLENCHEMENT (inchangé) : session AUTHENTIFIÉE, écran utilisable
 * de l'app (`isBiometricOfferPath`), jamais pendant la réacceptation des CGUV,
 * le verrou, la mise à jour obligatoire, un écran bloquant (environnement,
 * commerce) ; hors ligne : le push attend le retour du réseau.
 *
 * ORDRE, UNE SEULE DEMANDE NATIVE À LA FOIS (tous comptes confondus)
 *   1. Biométrie : état RÉEL relu (capteur + choix du compte sur ce
 *      téléphone). Indisponible / non enrôlée / bloquée / déjà active /
 *      déjà décidée (« proposé », « Plus tard », refusé, désactivé, à
 *      réactiver) → rien. Sinon « proposé » est noté PUIS le parcours natif
 *      est lancé (iOS : autorisation Face ID du système puis LAContext ;
 *      Android : BiometricPrompt) via `changeBiometrics` : « actif » n'est
 *      enregistré qu'après une vérification RÉUSSIE. Échec / annulation /
 *      refus → non activé, noté « refusé », jamais relancé automatiquement.
 *   2. Notifications, ENSUITE seulement (fin de la demande biométrique + une
 *      courte pause, pour que deux fenêtres système ne se chevauchent
 *      jamais) : permission RÉELLE relue. Déjà accordée → rien de plus que
 *      l'enregistrement du jeton, déjà fait à chaque session par
 *      `syncNativePush` (NativeBridgeRuntime) ; refusée / indisponible /
 *      déjà décidée sur cette installation → rien. Sinon « proposé » est
 *      noté PUIS la demande native est faite (`requestNativePush`, qui
 *      enregistre le jeton après accord) ; la réponse est notée.
 *
 * MÉMORISATION (stockages existants, aucun neuf) : biométrie
 * `biometric-consent` (par compte et par téléphone) ; notifications
 * `push-onboarding` (par compte et par installation). Notée AU MOMENT du
 * déclenchement natif : une app fermée pendant la demande ne la relance
 * jamais (aucune boucle à l'ouverture ni au retour au premier plan). Si la
 * note ne peut pas être écrite, la demande n'est PAS faite (sinon elle
 * reviendrait à chaque lancement).
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  changeBiometrics, deferBiometrics, isBiometricOfferPath, readBiometricSetting, shouldOfferBiometrics,
  type BiometricSetting, type BiometricsChange,
} from './biometric-consent';
import { nativePlatform } from './bridge';
import { initInstallationId } from './shell-info';
import {
  nativePushPermission, requestNativePush, type NativePushRequest, type NativePushState,
} from './push';
import {
  pushOnboardingDecision, readPushOnboarding, recordPushOnboarding,
  type PushOnboardingRecord, type PushOnboardingStored,
} from './push-onboarding';

/** Pause entre la fin d'une demande native et la suivante (jamais deux fenêtres système superposées). */
export const NATIVE_PROMPT_GAP_MS = 600;
/** Lecture de l'état trop longue : étape abandonnée pour ce lancement (rien n'est noté, rien n'est demandé). */
export const PERMISSION_READ_TIMEOUT_MS = 8000;

export interface NativePermissionsContext {
  /** Compte de la session AUTHENTIFIÉE, sinon null. */
  userId: number | null;
  /** Feature flag serveur `biometrics` (configuration non lue : actif). */
  biometricsOn: boolean;
  /** Feature flag serveur `push` (configuration non lue : actif). */
  pushOn: boolean;
  pathname: string | null | undefined;
  /** CGUV à réaccepter (écran obligatoire). */
  legalRequired: boolean;
  /** Verrou, mise à jour obligatoire, environnement, page commerciale. */
  blocked: boolean;
  offline: boolean;
}

export type BiometricStepOutcome =
  | 'feature_off' | 'not_applicable' | 'read_failed' | 'mark_failed'
  | 'enabled' | 'not_enabled' | 'storage_error';
export type PushStepOutcome =
  | 'feature_off' | 'already_granted' | 'not_applicable' | 'read_failed' | 'mark_failed'
  | 'granted' | 'granted_unregistered' | 'not_granted';

type StepState = 'running' | 'done';

export interface NativePermissionsSnapshot {
  bio: Readonly<Record<number, StepState>>;
  push: Readonly<Record<number, StepState>>;
  /** Étape en cours (lecture, demande native ou pause) : une seule à la fois. */
  active: { userId: number; step: 'bio' | 'push'; phase: 'reading' | 'prompting' | 'gap' } | null;
  /** Issue de chaque étape (diagnostic, tests). */
  outcomes: Readonly<Record<number, { bio?: BiometricStepOutcome; push?: PushStepOutcome }>>;
}

export interface NativePermissionsDeps {
  /**
   * Identifiant d'installation initialisé (lot 112E, appel seulement) AVANT
   * toute écriture : une réinstallation détectée purge le stockage sécurisé
   * (AUTH-13) ; elle doit précéder la note « proposé », jamais la suivre.
   */
  ready: () => Promise<unknown>;
  readBiometrics: (userId: number, featureOn: boolean) => Promise<BiometricSetting>;
  /** Note « proposé » ; false si la note n'a pas pu être écrite. */
  markBiometricsOffered: (userId: number) => Promise<boolean>;
  /** Parcours natif ; « actif » seulement après vérification réussie. */
  activateBiometrics: (userId: number) => Promise<BiometricsChange>;
  recordBiometricsRefused: (userId: number) => Promise<unknown>;
  pushPermission: () => Promise<NativePushState>;
  readPushDecision: (userId: number) => Promise<PushOnboardingRecord | null>;
  recordPushDecision: (userId: number, s: PushOnboardingStored, r?: NativePushState) => Promise<boolean>;
  requestPush: () => Promise<NativePushRequest>;
  delay: (ms: number) => Promise<void>;
}

const defaultDeps: NativePermissionsDeps = {
  ready: initInstallationId,
  readBiometrics: (userId, featureOn) => readBiometricSetting(nativePlatform(), userId, featureOn),
  markBiometricsOffered: (userId) => deferBiometrics(userId, 'offered'),
  activateBiometrics: (userId) => changeBiometrics(true, userId),
  recordBiometricsRefused: (userId) => deferBiometrics(userId, 'refused'),
  pushPermission: nativePushPermission,
  readPushDecision: readPushOnboarding,
  recordPushDecision: recordPushOnboarding,
  requestPush: requestNativePush,
  delay: (ms) => new Promise((r) => { setTimeout(r, ms); }),
};

/** Écran et session permettant une sollicitation (pur, testé). Le hors-ligne ne concerne que le push. */
export function nativePermissionsScreenAllowed(c: NativePermissionsContext): boolean {
  return c.userId !== null && !c.blocked && !c.legalRequired && isBiometricOfferPath(c.pathname);
}

const TIMED_OUT = Symbol('timeout');

export function createNativePermissions(deps: NativePermissionsDeps = defaultDeps) {
  let snap: NativePermissionsSnapshot = { bio: {}, push: {}, active: null, outcomes: {} };
  let last: NativePermissionsContext | null = null;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<NativePermissionsSnapshot>) => {
    snap = { ...snap, ...patch };
    listeners.forEach((l) => l());
  };
  const mark = (kind: 'bio' | 'push', userId: number, st: StepState | undefined) => {
    const next = { ...snap[kind] };
    if (st === undefined) delete next[userId]; else next[userId] = st;
    set({ [kind]: next } as Partial<NativePermissionsSnapshot>);
  };
  const outcome = (userId: number, o: { bio?: BiometricStepOutcome; push?: PushStepOutcome }) => {
    set({ outcomes: { ...snap.outcomes, [userId]: { ...snap.outcomes[userId], ...o } } });
  };
  /** Le contexte COURANT permet-il encore de solliciter ce compte ? */
  const stillAllowed = (userId: number, needOnline: boolean) =>
    !!last && last.userId === userId && nativePermissionsScreenAllowed(last) && !(needOnline && last.offline);

  async function withTimeout<T>(p: Promise<T>): Promise<T | typeof TIMED_OUT> {
    return Promise.race([p, deps.delay(PERMISSION_READ_TIMEOUT_MS).then((): typeof TIMED_OUT => TIMED_OUT)]);
  }

  async function finish(): Promise<void> {
    set({ active: null });
    if (last) api.sync(last);
  }

  async function runBiometrics(u: number, featureOn: boolean): Promise<void> {
    mark('bio', u, 'running');
    set({ active: { userId: u, step: 'bio', phase: 'reading' } });
    let setting: BiometricSetting | typeof TIMED_OUT;
    try {
      setting = await withTimeout(deps.ready().catch(() => null).then(() => deps.readBiometrics(u, featureOn)));
    } catch {
      setting = TIMED_OUT;
    }
    if (setting === TIMED_OUT) {
      mark('bio', u, 'done');
      outcome(u, { bio: 'read_failed' });
      return finish();
    }
    // Compte changé, verrou, CGUV… pendant la lecture : rien n'est perdu, réévaluée plus tard.
    if (!stillAllowed(u, false)) { mark('bio', u, undefined); return finish(); }
    const due = shouldOfferBiometrics({
      featureOn, sessionStatus: 'authenticated', userId: u, pathname: last!.pathname,
      legalRequired: last!.legalRequired, blocked: last!.blocked, setting,
    });
    if (!due) {
      mark('bio', u, 'done');
      outcome(u, { bio: 'not_applicable' });
      return finish();
    }
    // « Proposé » noté AU déclenchement natif ; sans note, pas de demande (jamais de boucle).
    let noted = false;
    try { noted = await deps.markBiometricsOffered(u); } catch { noted = false; }
    if (!noted) {
      mark('bio', u, 'done');
      outcome(u, { bio: 'mark_failed' });
      return finish();
    }
    set({ active: { userId: u, step: 'bio', phase: 'prompting' } });
    let r: BiometricsChange;
    try { r = await deps.activateBiometrics(u); } catch { r = 'refused'; }
    if (r === 'refused' || r === 'unavailable') {
      await Promise.resolve(deps.recordBiometricsRefused(u)).catch(() => undefined);
    }
    mark('bio', u, 'done');
    outcome(u, { bio: r === 'enabled' ? 'enabled' : r === 'storage_error' ? 'storage_error' : 'not_enabled' });
    // Pause : la fenêtre système biométrique est refermée avant toute autre demande.
    set({ active: { userId: u, step: 'bio', phase: 'gap' } });
    await deps.delay(NATIVE_PROMPT_GAP_MS);
    return finish();
  }

  async function runPush(u: number): Promise<void> {
    mark('push', u, 'running');
    set({ active: { userId: u, step: 'push', phase: 'reading' } });
    let read: [NativePushState, PushOnboardingRecord | null] | typeof TIMED_OUT;
    try {
      read = await withTimeout(Promise.all([deps.pushPermission(), deps.readPushDecision(u)]));
    } catch {
      read = TIMED_OUT;
    }
    if (read === TIMED_OUT) {
      mark('push', u, 'done');
      outcome(u, { push: 'read_failed' });
      return finish();
    }
    if (!stillAllowed(u, true)) { mark('push', u, undefined); return finish(); }
    const [permission, record] = read;
    if (pushOnboardingDecision({ permission, record }) !== 'offer') {
      mark('push', u, 'done');
      // Déjà accordée : le jeton est enregistré par `syncNativePush` (chaque session).
      outcome(u, { push: permission === 'granted' ? 'already_granted' : 'not_applicable' });
      return finish();
    }
    let noted = false;
    try { noted = await deps.recordPushDecision(u, 'offered'); } catch { noted = false; }
    if (!noted) {
      mark('push', u, 'done');
      outcome(u, { push: 'mark_failed' });
      return finish();
    }
    set({ active: { userId: u, step: 'push', phase: 'prompting' } });
    let r: NativePushRequest = { state: 'unavailable', registered: false };
    try { r = await deps.requestPush(); } catch { /* issue « indisponible » */ }
    await deps.recordPushDecision(u, 'answered', r.state).catch(() => false);
    mark('push', u, 'done');
    outcome(u, { push: r.state === 'granted' ? (r.registered ? 'granted' : 'granted_unregistered') : 'not_granted' });
    return finish();
  }

  const api = {
    getSnapshot: () => snap,
    subscribe(l: () => void): () => void {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },

    /**
     * À chaque changement d'écran / de session / de réseau. Lance au plus UNE
     * étape, et seulement si aucune n'est en cours (lecture, demande native ou
     * pause), tous comptes confondus.
     */
    sync(c: NativePermissionsContext): void {
      last = c;
      if (snap.active) return;
      const u = c.userId;
      if (u === null || !nativePermissionsScreenAllowed(c)) return;
      if (snap.bio[u] === undefined) {
        if (!c.biometricsOn) {
          mark('bio', u, 'done');
          outcome(u, { bio: 'feature_off' });
        } else {
          void runBiometrics(u, true);
          return;
        }
      }
      if (snap.bio[u] !== 'done' || snap.push[u] !== undefined) return;
      if (!c.pushOn) {
        mark('push', u, 'done');
        outcome(u, { push: 'feature_off' });
        return;
      }
      if (c.offline) return; // attend le retour du réseau
      void runPush(u);
    },
  };
  return api;
}

export type NativePermissionsController = ReturnType<typeof createNativePermissions>;

let shared: NativePermissionsController | null = null;

/** Contrôleur unique du lancement (l'hôte natif n'est monté qu'une fois). */
export function sharedNativePermissions(): NativePermissionsController {
  if (!shared) shared = createNativePermissions();
  return shared;
}
