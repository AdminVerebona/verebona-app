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
 * ══════════════════════════════════════════════════════════════════════════
 */
import { UNLOCK_WITHOUT_BIOMETRICS, shouldLockOnResume, type PromptOutcome } from './app-lock';

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

export type SessionKnown = 'checking' | 'authenticated' | 'unauthenticated' | 'temporarily-unavailable';
export type PromptMode = 'biometry' | 'device_credential';
export type FallbackReason = Exclude<PromptOutcome, 'ok'> | 'reactivate' | 'not_enabled';
export type FallbackAction = 'retry_biometry' | 'other_method' | 'device_credential' | 'sign_in';

export interface UnlockMethod {
  /** Déverrouillage biométrique actif et utilisable pour ce compte. */
  biometry: boolean;
  biometryAvailable: boolean;
  deviceSecure: boolean;
  /** Pourquoi la biométrie n'est pas utilisée (si `biometry` est faux). */
  whyNot?: 'reactivate' | 'unavailable' | 'not_enabled';
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
}

export type UnlockEvent =
  | { type: 'BOOT'; now: number; backgroundAt: number | null }
  | { type: 'BACKGROUND'; now: number }
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
  | { type: 'navigate'; path: string }
  /** « Se reconnecter » : connexion complète, destination conservée, préférence biométrique gardée. */
  | { type: 'sign_in_again'; returnPath: string | null }
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

function unlock(s: UnlockState, effects: UnlockEffect[]): Transition {
  const out: UnlockEffect[] = [...effects, { type: 'clear_background' }];
  if (s.pendingPath) out.push({ type: 'navigate', path: s.pendingPath });
  return {
    state: { ...s, phase: 'unlocked', method: null, methodRequested: false, promptMode: null, fallback: null, sawBackground: false, pendingPath: null },
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
  if (!sessionUsable(s.session)) return unlock(s, effects);
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
  return { reason: outcome, mode, actions: ['retry_biometry', 'other_method'] };
}

/** Transition (pure). */
export function reduceUnlock(s: UnlockState, e: UnlockEvent): Transition {
  switch (e.type) {
    case 'BOOT': {
      if (shouldLockOnResume(e.backgroundAt, e.now)) {
        // Démarrage à froid : la première lecture de session tient lieu de vérification.
        return enterPending({ ...s, sessionVerified: false }, false);
      }
      return { state: { ...s, phase: 'unlocked' }, effects: e.backgroundAt !== null ? [{ type: 'clear_background' }] : [] };
    }

    case 'BACKGROUND': {
      // Fenêtre système (Face ID, code) : l'app devient « inactive » — ignoré.
      if (s.phase === 'prompting' || s.phase === 'verifying') return { state: s, effects: [] };
      if (s.phase === 'unlocked') {
        if (s.session === 'unauthenticated') return { state: s, effects: [] };
        return { state: { ...s, phase: 'covered' }, effects: [{ type: 'persist_background', at: e.now }] };
      }
      if (s.phase === 'covered') return { state: s, effects: [] };
      return { state: { ...s, sawBackground: true }, effects: [] };
    }

    case 'RESUME': {
      if (s.phase === 'covered' || s.phase === 'unlocked') {
        if (shouldLockOnResume(e.backgroundAt, e.now)) return enterPending(s, true);
        if (s.phase === 'unlocked') return { state: s, effects: [] };
        // Lien reçu pendant l'arrière-plan : ouvert maintenant.
        return unlock(s, []);
      }
      // Nouvelle reprise après un vrai passage en arrière-plan depuis l'écran
      // de secours : une nouvelle sollicitation est permise (une par reprise).
      if (s.phase === 'fallback' && s.sawBackground) return enterPending(s, true);
      return { state: s, effects: [] };
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
      if (s.phase !== 'fallback' || !s.fallback?.actions.includes('other_method')) return { state: s, effects: [] };
      if (deviceCredentialPossible(s.method)) return prompt(s, 'device_credential', []);
      return { state: s, effects: [{ type: 'sign_in_again', returnPath: s.pendingPath }] };
    }

    case 'DEVICE_CREDENTIAL': {
      if (s.phase !== 'fallback' || !s.fallback?.actions.includes('device_credential')) return { state: s, effects: [] };
      return prompt(s, 'device_credential', []);
    }

    case 'SIGN_IN': {
      if (s.phase !== 'fallback') return { state: s, effects: [] };
      return { state: s, effects: [{ type: 'sign_in_again', returnPath: s.pendingPath }] };
    }

    case 'NAVIGATE': {
      if (s.phase === 'unlocked') return { state: s, effects: [{ type: 'navigate', path: e.path }] };
      return { state: { ...s, pendingPath: e.path }, effects: [] };
    }

    case 'SIGNED_OUT': {
      return {
        state: { ...s, phase: 'unlocked', session: 'unauthenticated', userId: null, method: null, methodRequested: false, promptMode: null, fallback: null, pendingPath: null, attempt: s.attempt + 1 },
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
  }
}

export function fallbackActionLabel(a: FallbackAction, retry: string): string {
  switch (a) {
    case 'retry_biometry': return retry;
    case 'other_method': return 'Utiliser une autre méthode';
    case 'device_credential': return 'Utiliser le code du téléphone';
    case 'sign_in': return 'Se reconnecter';
  }
}
