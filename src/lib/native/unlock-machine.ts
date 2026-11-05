/**
 * Machine d'états du déverrouillage de l'application native — lot 107A
 * (ticket P1 « Face ID automatique à la reprise »). Module PUR : aucun appel
 * natif, aucun DOM ; testé avec un pont simulé (`unlock-controller.ts`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PARCOURS
 *   · Reprise < 5 min d'arrière-plan : rien (ni Face ID, ni écran).
 *   · Reprise ≥ 5 min, ou démarrage à froid après ≥ 5 min : l'app est
 *     masquée (aucune donnée visible), puis, si le déverrouillage biométrique
 *     est actif pour CE compte sur CET appareil, Face ID / Touch ID /
 *     biométrie Android est lancé AUTOMATIQUEMENT ; succès + session serveur
 *     valide → le dernier écran réapparaît tel quel (il n'a jamais été démonté).
 *   · Échec, annulation, blocage, biométrie indisponible ou non activée :
 *     écran de secours sobre, actions volontaires uniquement (aucune
 *     relance automatique : pas de boucle).
 *   · Une seule sollicitation par reprise : la fenêtre système rend l'app
 *     « inactive » le temps de la vérification — ces passages sont ignorés.
 *   · La session serveur est RELUE à chaque verrou ; expirée / révoquée →
 *     connexion complète. La biométrie ne contourne jamais le serveur.
 *   · Lien profond / notification pendant le verrou : destination conservée,
 *     ouverte après le déverrouillage.
 *
 * LOT 111D (anomalie de recette #642 bis — écran « Déverrouiller Verebona »
 * affiché à la place de Face ID). Causes établies par le code et corrigées ICI,
 * dans cette même machine (aucune seconde logique) :
 *   1. Moyen de déverrouillage lu SANS identité : démarrage à froid ou
 *      rechargement de la vue (iOS recharge la WebView quand le système a
 *      fermé son processus en arrière-plan) avec `/api/users/me` en échec
 *      momentané → session « momentanément indisponible » SANS utilisateur →
 *      lecture pour `userId = null` → « non activé » → écran de secours
 *      « Confirmez qu'il s'agit bien de vous… », jamais réévalué quand
 *      l'identité arrivait. Désormais : attente de l'identité (voile neutre),
 *      puis Face ID ; écran « connexion impossible » seulement après un délai.
 *   2. Décision prise APP EN ARRIÈRE-PLAN (vue rechargée en arrière-plan,
 *      téléphone verrouillé) : Keychain illisible (« non activé ») ou fenêtre
 *      système refusée (« interrompu »), et la reprise suivante était ignorée
 *      (aucun passage en arrière-plan vu depuis ce démarrage). Désormais : le
 *      moyen n'est lu et Face ID n'est lancé qu'AU PREMIER PLAN.
 *   3. Session sans preuve forte alors que la double authentification est
 *      exigée (lot 110B, 403 `MFA_REQUIRED`) : traitée comme une panne
 *      réseau. Désormais : reconnexion réelle (« reauth-required »).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { UNLOCK_WITHOUT_BIOMETRICS, shouldLockOnResume, type PromptOutcome } from './app-lock';
import { MFA_REQUIRED_CODE, MFA_REQUIRED_MESSAGE } from '@/lib/auth/mfa/constants';

/**
 * Sans biométrie activée, lancer AUTOMATIQUEMENT la demande du code du
 * téléphone ? Choix par défaut (point unique, à confirmer par le PO) : NON —
 * l'utilisateur n'a pas choisi le déverrouillage rapide ; l'écran de secours
 * propose « Utiliser le code du téléphone » et « Se reconnecter ».
 */
export const AUTO_PROMPT_WITHOUT_BIOMETRICS = false;

export type LockPhase =
  /** Application visible. */
  | 'unlocked'
  /** En arrière-plan : contenu masqué par prudence, décision au retour. */
  | 'covered'
  /** Verrou dû : contenu masqué, moyen de déverrouillage en cours de lecture. */
  | 'pending'
  /** Fenêtre système (Face ID / code) affichée. */
  | 'prompting'
  /** Vérification locale réussie, relecture de la session serveur en cours. */
  | 'verifying'
  /** Écran de secours. */
  | 'fallback';

/**
 * `reauth-required` (lot 111D) : le serveur refuse la session faute de preuve
 * forte (double authentification exigée, 110B) — la biométrie locale ne peut
 * pas y suppléer : reconnexion réelle.
 */
export type SessionKnown = 'checking' | 'authenticated' | 'unauthenticated' | 'temporarily-unavailable' | 'reauth-required';
export type PromptMode = 'biometry' | 'device_credential';
export type FallbackReason = Exclude<PromptOutcome, 'ok'> | 'reactivate' | 'not_enabled'
  /** Lot 111D : identité du compte inconnue (service injoignable) après le délai d'attente. */
  | 'session_unavailable'
  /** Lot 111D : reconnexion exigée par le serveur (double authentification). */
  | 'sign_in_required';
/** `other_method` : conservé pour compatibilité (plus proposé depuis 111D : action explicite « code du téléphone »). */
export type FallbackAction = 'retry_biometry' | 'other_method' | 'device_credential' | 'sign_in' | 'retry_session';

/**
 * Lot 111D — délai d'attente de l'identité (session momentanément
 * indisponible sans utilisateur connu) avant l'écran « connexion impossible ».
 * Le contenu reste masqué pendant ce délai ; Face ID part dès l'identité connue.
 */
export const IDENTITY_WAIT_MS = 6_000;

/**
 * État de session vu par le verrou (pur, testé) : un refus « double
 * authentification exigée » (403 `MFA_REQUIRED`, classé « indisponible » par
 * le magasin de session) devient `reauth-required`.
 */
export function unlockSessionStatus(status: string, errorCode?: string | null): SessionKnown {
  if (status === 'temporarily-unavailable' && errorCode === MFA_REQUIRED_CODE) return 'reauth-required';
  if (status === 'checking' || status === 'authenticated' || status === 'unauthenticated' || status === 'temporarily-unavailable') return status;
  return 'temporarily-unavailable';
}

export interface UnlockMethod {
  /** Déverrouillage biométrique actif et utilisable pour ce compte. */
  biometry: boolean;
  biometryAvailable: boolean;
  deviceSecure: boolean;
  /** Pourquoi la biométrie n'est pas utilisée (si `biometry` est faux). */
  whyNot?: 'reactivate' | 'unavailable' | 'not_enabled';
  /** Lot 111D : codes de diagnostic (journal technique), jamais de donnée biométrique ni d'identifiant. */
  diag?: Record<string, string | number | boolean | null>;
}

export interface UnlockFallback { reason: FallbackReason; actions: FallbackAction[]; mode: PromptMode }

export interface UnlockState {
  phase: LockPhase;
  session: SessionKnown;
  userId: number | null;
  /** Session relue depuis le début de ce verrou. */
  sessionVerified: boolean;
  /** Moyen de déverrouillage du compte (lu à chaque verrou). */
  method: UnlockMethod | null;
  methodRequested: boolean;
  /** Numéro de la tentative en cours : un résultat d'une autre tentative est ignoré. */
  attempt: number;
  promptMode: PromptMode | null;
  fallback: UnlockFallback | null;
  /** Vrai passage en arrière-plan pendant le verrou (hors fenêtre système). */
  sawBackground: boolean;
  /** Destination demandée pendant le verrou (lien profond, notification). */
  pendingPath: string | null;
  /**
   * Lot 111D : l'app est au premier plan (Keychain lisible, fenêtre système
   * possible). Faux après un départ en arrière-plan ou un démarrage en
   * arrière-plan (vue rechargée par le système).
   */
  foreground: boolean;
  /** Lot 111D : un événement de cycle de vie a été reçu depuis le démarrage. */
  lifecycleSeen: boolean;
  /** Lot 111D : attente de l'identité armée pour la tentative en cours. */
  identityWait: boolean;
  /** Lot 111D : nouvelle fenêtre automatique déjà accordée après une interruption système. */
  interruptRetried: boolean;
}

export type UnlockEvent =
  /** `foreground` (111D) : visibilité de la page au démarrage (absent = premier plan). */
  | { type: 'BOOT'; now: number; backgroundAt: number | null; foreground?: boolean }
  | { type: 'BACKGROUND'; now: number }
  /**
   * Lot 111D : sonde « app en arrière-plan » au démarrage (état natif lu après
   * le chargement). Ignorée dès qu'un vrai événement de cycle de vie est arrivé
   * (réponse périmée).
   */
  | { type: 'BACKGROUND_PROBE'; now: number }
  /** Lot 111D : délai d'attente de l'identité écoulé (tentative numérotée). */
  | { type: 'IDENTITY_TIMEOUT'; attempt: number }
  /** Lot 111D : « Réessayer » de l'écran « connexion impossible ». */
  | { type: 'RETRY_SESSION' }
  | { type: 'RESUME'; now: number; backgroundAt: number | null }
  | { type: 'SESSION'; status: SessionKnown; userId: number | null }
  | { type: 'SESSION_VERIFIED'; status: SessionKnown; userId: number | null }
  | { type: 'METHOD'; userId: number | null; method: UnlockMethod }
  | { type: 'PROMPT_RESULT'; attempt: number; outcome: PromptOutcome }
  | { type: 'RETRY' }
  | { type: 'OTHER_METHOD' }
  | { type: 'DEVICE_CREDENTIAL' }
  | { type: 'SIGN_IN' }
  | { type: 'NAVIGATE'; path: string }
  | { type: 'SIGNED_OUT' };

export type UnlockEffect =
  | { type: 'persist_background'; at: number }
  | { type: 'clear_background' }
  | { type: 'read_method'; userId: number | null }
  | { type: 'verify_session' }
  | { type: 'prompt'; mode: PromptMode; attempt: number }
  /** Lot 111D : attendre l'identité au plus `IDENTITY_WAIT_MS`, puis `IDENTITY_TIMEOUT`. */
  | { type: 'await_identity'; attempt: number }
  | { type: 'navigate'; path: string }
  /**
   * « Se reconnecter » : connexion complète, destination conservée, préférence
   * biométrique gardée. `reason` (111D) : motif affiché par l'écran de connexion.
   */
  | { type: 'sign_in_again'; returnPath: string | null; reason?: 'mfa_required' }
  /** Session serveur refusée pendant le verrou : procédure de sortie habituelle. */
  | { type: 'exit_session' };

export interface Transition { state: UnlockState; effects: UnlockEffect[] }

export const INITIAL_UNLOCK_STATE: UnlockState = Object.freeze({
  phase: 'unlocked',
  session: 'checking',
  userId: null,
  sessionVerified: false,
  method: null,
  methodRequested: false,
  attempt: 0,
  promptMode: null,
  fallback: null,
  sawBackground: false,
  pendingPath: null,
  foreground: true,
  lifecycleSeen: false,
  identityWait: false,
  interruptRetried: false,
}) as UnlockState;

/** Le contenu de l'app est-il masqué ? */
export function isCovered(s: Pick<UnlockState, 'phase'>): boolean {
  return s.phase !== 'unlocked';
}

const sessionUsable = (s: SessionKnown) => s === 'authenticated' || s === 'temporarily-unavailable';

function deviceCredentialPossible(m: UnlockMethod | null): boolean {
  return UNLOCK_WITHOUT_BIOMETRICS === 'device_credential' && !!m && (m.deviceSecure || m.biometryAvailable);
}

/** Actions de l'écran de secours quand la biométrie ne peut pas servir (pur). */
function withoutBiometryActions(m: UnlockMethod | null): FallbackAction[] {
  return deviceCredentialPossible(m) ? ['device_credential', 'sign_in'] : ['sign_in'];
}

const SIGN_IN_REQUIRED: UnlockFallback = Object.freeze({ reason: 'sign_in_required', actions: ['sign_in'], mode: 'biometry' }) as UnlockFallback;

function toFallback(s: UnlockState, fallback: UnlockFallback, effects: UnlockEffect[] = []): Transition {
  return { state: { ...s, phase: 'fallback', fallback, promptMode: null }, effects };
}

function unlock(s: UnlockState, effects: UnlockEffect[]): Transition {
  const out: UnlockEffect[] = [...effects, { type: 'clear_background' }];
  if (s.pendingPath) out.push({ type: 'navigate', path: s.pendingPath });
  return {
    state: {
      ...s, phase: 'unlocked', method: null, methodRequested: false, promptMode: null, fallback: null, sawBackground: false, pendingPath: null,
      identityWait: false, interruptRetried: false,
    },
    effects: out,
  };
}

function prompt(s: UnlockState, mode: PromptMode, effects: UnlockEffect[]): Transition {
  const attempt = s.attempt + 1;
  return {
    state: { ...s, phase: 'prompting', attempt, promptMode: mode, fallback: null, sawBackground: false },
    effects: [...effects, { type: 'prompt', mode, attempt }],
  };
}

/** Entrée dans un verrou : contenu masqué, moyen relu, session relue si demandé. */
function enterPending(s: UnlockState, verify: boolean, effects: UnlockEffect[] = []): Transition {
  const next: UnlockState = {
    ...s,
    phase: 'pending',
    method: null,
    methodRequested: false,
    // Une tentative éventuellement en cours est périmée.
    attempt: s.attempt + 1,
    promptMode: null,
    fallback: null,
    sawBackground: false,
    identityWait: false,
    sessionVerified: verify ? false : s.sessionVerified,
  };
  const out = [...effects];
  if (verify) out.push({ type: 'verify_session' });
  return advance(next, out);
}

/** Décision dans l'état `pending` dès que la session et le moyen sont connus. */
function advance(s: UnlockState, effects: UnlockEffect[]): Transition {
  if (s.phase !== 'pending') return { state: s, effects };
  if (s.session === 'checking') return { state: s, effects };
  // 111D : la biométrie ne remplace pas la preuve forte exigée par le serveur.
  if (s.session === 'reauth-required') return toFallback(s, SIGN_IN_REQUIRED, effects);
  if (!sessionUsable(s.session)) return unlock(s, effects);
  // 111D (cause 1) : jamais de lecture du moyen sans identité — on attend le compte.
  if (s.userId === null) {
    if (s.identityWait) return { state: s, effects };
    return { state: { ...s, identityWait: true }, effects: [...effects, { type: 'await_identity', attempt: s.attempt }] };
  }
  // 111D (cause 2) : décision au premier plan seulement (Keychain lisible, fenêtre système possible).
  if (!s.foreground) return { state: s, effects };
  if (!s.method) {
    if (s.methodRequested) return { state: s, effects };
    return { state: { ...s, methodRequested: true }, effects: [...effects, { type: 'read_method', userId: s.userId }] };
  }
  if (s.method.biometry) return prompt(s, 'biometry', effects);
  if (AUTO_PROMPT_WITHOUT_BIOMETRICS && deviceCredentialPossible(s.method) && s.method.whyNot === 'not_enabled') {
    return prompt(s, 'device_credential', effects);
  }
  return {
    state: { ...s, phase: 'fallback', fallback: { reason: s.method.whyNot ?? 'not_enabled', actions: withoutBiometryActions(s.method), mode: 'device_credential' } },
    effects,
  };
}

function fallbackAfter(s: UnlockState, outcome: Exclude<PromptOutcome, 'ok'>): UnlockFallback {
  const mode = s.promptMode ?? 'biometry';
  if (mode === 'device_credential') {
    return { reason: outcome, mode, actions: outcome === 'unavailable' ? ['sign_in'] : withoutBiometryActions(s.method) };
  }
  if (outcome === 'lockout' || outcome === 'unavailable') return { reason: outcome, mode, actions: withoutBiometryActions(s.method) };
  // 111D : « Réessayer Face ID » (volontaire), code du téléphone par l'API du
  // système si possible, reconnexion toujours accessible (en dernier).
  return { reason: outcome, mode, actions: deviceCredentialPossible(s.method) ? ['retry_biometry', 'device_credential', 'sign_in'] : ['retry_biometry', 'sign_in'] };
}

/** Retour au premier plan (pur) — partagé par `RESUME`. */
function resume(s0: UnlockState, e: { now: number; backgroundAt: number | null }): Transition {
  const s: UnlockState = { ...s0, foreground: true, lifecycleSeen: true };
  if (s.phase === 'covered' || s.phase === 'unlocked') {
    if (shouldLockOnResume(e.backgroundAt, e.now)) return enterPending(s, true);
    if (s.phase === 'unlocked') return { state: s, effects: [] };
    // Lien reçu pendant l'arrière-plan : ouvert maintenant.
    return unlock(s, []);
  }
  // 111D : verrou décidé pendant que l'app était en arrière-plan → décision maintenant.
  if (s.phase === 'pending') return advance(s, []);
  if (s.phase === 'fallback') {
    // Nouvelle reprise après un vrai passage en arrière-plan depuis l'écran
    // de secours : une nouvelle sollicitation est permise (une par reprise).
    if (s.sawBackground) return enterPending(s, true);
    // 111D : fenêtre interrompue par le système (appel, centre de contrôle,
    // app quittée) : UNE nouvelle fenêtre automatique au retour, pas plus.
    if (s.fallback?.reason === 'interrupted' && s.fallback.mode === 'biometry' && !s.interruptRetried) {
      return enterPending({ ...s, interruptRetried: true }, true);
    }
  }
  return { state: s, effects: [] };
}

/** Départ en arrière-plan (hors fenêtre système) — pur. */
function background(s: UnlockState, now: number): Transition {
  if (s.phase === 'unlocked') {
    if (s.session === 'unauthenticated') return { state: { ...s, foreground: false }, effects: [] };
    return { state: { ...s, phase: 'covered', foreground: false }, effects: [{ type: 'persist_background', at: now }] };
  }
  if (s.phase === 'covered') return { state: { ...s, foreground: false }, effects: [] };
  return { state: { ...s, sawBackground: true, foreground: false }, effects: [] };
}

/**
 * Session connue APRÈS une décision (lot 111D) : identité arrivée pendant
 * l'écran « connexion impossible » → déverrouillage normal (Face ID) ;
 * reconnexion exigée pendant le verrou → écran « Se reconnecter ». Pur.
 */
function lateSession(next: UnlockState): Transition | null {
  if (next.phase === 'unlocked' || next.phase === 'covered') return null;
  if (next.session === 'reauth-required') {
    return next.phase === 'fallback' && next.fallback?.reason === 'sign_in_required' ? { state: next, effects: [] } : toFallback(next, SIGN_IN_REQUIRED);
  }
  if (next.phase === 'fallback' && next.userId !== null && sessionUsable(next.session)
    && (next.fallback?.reason === 'session_unavailable' || next.fallback?.reason === 'sign_in_required')) {
    return enterPending(next, false);
  }
  return null;
}

/** Transition (pure). */
export function reduceUnlock(s: UnlockState, e: UnlockEvent): Transition {
  switch (e.type) {
    case 'BOOT': {
      const booted: UnlockState = { ...s, foreground: e.foreground !== false, lifecycleSeen: false, interruptRetried: false };
      if (shouldLockOnResume(e.backgroundAt, e.now)) {
        // Démarrage à froid : la première lecture de session tient lieu de vérification.
        return enterPending({ ...booted, sessionVerified: false }, false);
      }
      return { state: { ...booted, phase: 'unlocked' }, effects: e.backgroundAt !== null ? [{ type: 'clear_background' }] : [] };
    }

    case 'BACKGROUND': {
      // Fenêtre système (Face ID, code) : l'app devient « inactive » — ignoré.
      if (s.phase === 'prompting' || s.phase === 'verifying') return { state: s, effects: [] };
      return background({ ...s, lifecycleSeen: true }, e.now);
    }

    case 'BACKGROUND_PROBE': {
      // Réponse périmée si un vrai événement de cycle de vie est déjà arrivé.
      if (s.lifecycleSeen || s.phase === 'prompting' || s.phase === 'verifying') return { state: s, effects: [] };
      return background(s, e.now);
    }

    case 'RESUME': return resume(s, e);

    case 'IDENTITY_TIMEOUT': {
      if (s.phase !== 'pending' || e.attempt !== s.attempt || s.userId !== null || !sessionUsable(s.session)) return { state: s, effects: [] };
      return toFallback({ ...s, identityWait: false }, { reason: 'session_unavailable', actions: ['retry_session', 'sign_in'], mode: 'biometry' });
    }

    case 'RETRY_SESSION': {
      if (s.phase !== 'fallback' || !s.fallback?.actions.includes('retry_session')) return { state: s, effects: [] };
      return enterPending(s, true);
    }

    case 'SESSION': {
      const fresh = s.session === 'checking' && e.status !== 'checking';
      const accountChanged = s.userId !== null && e.userId !== null && e.userId !== s.userId;
      let next: UnlockState = {
        ...s,
        session: e.status,
        userId: e.userId ?? (e.status === 'unauthenticated' ? null : s.userId),
        sessionVerified: s.sessionVerified || fresh,
      };
      if (e.status === 'unauthenticated') {
        if (next.phase === 'unlocked') return { state: next, effects: [] };
        return unlock({ ...next, pendingPath: null }, []);
      }
      if (accountChanged && next.phase !== 'unlocked' && next.phase !== 'covered') {
        // Changement de compte pendant le verrou : rien du compte précédent ne sert.
        return enterPending(next, false);
      }
      const late = lateSession(next);
      if (late) return late;
      if (next.phase === 'verifying' && next.sessionVerified && sessionUsable(next.session)) return unlock(next, []);
      next = { ...next };
      return advance(next, []);
    }

    case 'SESSION_VERIFIED': {
      const hadUser = s.userId !== null;
      const accountChanged = s.userId !== null && e.userId !== null && e.userId !== s.userId;
      const next: UnlockState = { ...s, session: e.status, userId: e.userId ?? (e.status === 'unauthenticated' ? null : s.userId), sessionVerified: true };
      if (next.phase === 'unlocked' || next.phase === 'covered') return { state: next, effects: [] };
      if (e.status === 'unauthenticated') {
        return unlock({ ...next, pendingPath: null }, hadUser ? [{ type: 'exit_session' }] : []);
      }
      if (accountChanged) return enterPending(next, false);
      const late = lateSession(next);
      if (late) return late;
      if (next.phase === 'verifying' && sessionUsable(next.session)) return unlock(next, []);
      return advance(next, []);
    }

    case 'METHOD': {
      if (s.phase !== 'pending' || e.userId !== s.userId) return { state: s, effects: [] };
      return advance({ ...s, method: e.method }, []);
    }

    case 'PROMPT_RESULT': {
      if (s.phase !== 'prompting' || e.attempt !== s.attempt) return { state: s, effects: [] };
      if (e.outcome === 'ok') {
        if (s.session === 'reauth-required') return toFallback(s, SIGN_IN_REQUIRED);
        if (s.sessionVerified && sessionUsable(s.session)) return unlock(s, []);
        return { state: { ...s, phase: 'verifying', promptMode: null }, effects: [] };
      }
      return { state: { ...s, phase: 'fallback', fallback: fallbackAfter(s, e.outcome), promptMode: null }, effects: [] };
    }

    case 'RETRY': {
      if (s.phase !== 'fallback' || !s.fallback?.actions.includes('retry_biometry')) return { state: s, effects: [] };
      return prompt(s, 'biometry', []);
    }

    case 'OTHER_METHOD': {
      // Compatibilité (écrans antérieurs à 111D) : « autre méthode » = code du téléphone, sinon reconnexion.
      if (s.phase !== 'fallback' || !s.fallback?.actions.some((a) => a === 'other_method' || a === 'device_credential' || a === 'sign_in')) return { state: s, effects: [] };
      if (deviceCredentialPossible(s.method)) return prompt(s, 'device_credential', []);
      return { state: s, effects: [{ type: 'sign_in_again', returnPath: s.pendingPath }] };
    }

    case 'DEVICE_CREDENTIAL': {
      if (s.phase !== 'fallback' || !s.fallback?.actions.includes('device_credential')) return { state: s, effects: [] };
      return prompt(s, 'device_credential', []);
    }

    case 'SIGN_IN': {
      if (s.phase !== 'fallback') return { state: s, effects: [] };
      const reason = s.fallback?.reason === 'sign_in_required' ? { reason: 'mfa_required' as const } : {};
      return { state: s, effects: [{ type: 'sign_in_again', returnPath: s.pendingPath, ...reason }] };
    }

    case 'NAVIGATE': {
      if (s.phase === 'unlocked') return { state: s, effects: [{ type: 'navigate', path: e.path }] };
      return { state: { ...s, pendingPath: e.path }, effects: [] };
    }

    case 'SIGNED_OUT': {
      return {
        state: {
          ...s, phase: 'unlocked', session: 'unauthenticated', userId: null, method: null, methodRequested: false, promptMode: null, fallback: null, pendingPath: null,
          attempt: s.attempt + 1, identityWait: false, interruptRetried: false,
        },
        effects: [{ type: 'clear_background' }],
      };
    }
  }
}

// ── Textes de l'écran de secours (purs, testés) ────────────────────────────

/** `short` : « Face ID », « Touch ID » ou « la biométrie ». */
function capital(short: string): string {
  return short.charAt(0).toUpperCase() + short.slice(1);
}

export const UNLOCK_FALLBACK_TITLE = 'Déverrouiller Verebona';

/** Message court, jamais d'explication des 5 minutes. */
export function fallbackMessage(f: Pick<UnlockFallback, 'reason' | 'mode'>, short: string): string {
  const who = f.mode === 'device_credential' ? 'La vérification' : capital(short);
  switch (f.reason) {
    case 'cancelled': return 'Vérification annulée.';
    case 'failed': return `${who} n’a pas abouti.`;
    case 'interrupted': return 'Vérification interrompue.';
    case 'lockout': return `Le téléphone a momentanément bloqué ${short}.`;
    case 'unavailable': return f.mode === 'device_credential'
      ? 'Aucun code n’est défini sur ce téléphone.'
      : `${capital(short)} n’est pas disponible pour le moment.`;
    case 'reactivate': return `Les visages ou empreintes enregistrés dans ce téléphone ont changé : par sécurité, ${short} est suspendu pour Verebona. Vous pourrez le réactiver dans Mon compte › Sécurité.`;
    case 'not_enabled': return 'Confirmez qu’il s’agit bien de vous pour continuer.';
    case 'session_unavailable': return 'Connexion au service impossible pour le moment. Vos données restent protégées.';
    case 'sign_in_required': return MFA_REQUIRED_MESSAGE;
  }
}

export function fallbackActionLabel(a: FallbackAction, retry: string): string {
  switch (a) {
    case 'retry_biometry': return retry;
    case 'other_method': return 'Utiliser une autre méthode';
    case 'device_credential': return 'Utiliser le code du téléphone';
    case 'sign_in': return 'Se reconnecter';
    case 'retry_session': return 'Réessayer';
  }
}
