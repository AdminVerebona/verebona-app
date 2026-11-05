/**
 * Exécution de la machine de déverrouillage — lot 107A. Relie la machine
 * pure (`unlock-machine.ts`) au pont natif, à la session et à la navigation,
 * tous INJECTÉS : les tests unitaires remplacent chaque dépendance par un
 * double (reprise < / > 5 min, froid, échec, annulation, double reprise…).
 *
 * Garanties tenues ici (en plus de la machine) :
 *   · une seule fenêtre biométrique à la fois (tentative numérotée ; un
 *     résultat tardif d'une tentative périmée est ignoré) ;
 *   · le masquage du contenu suit l'état À CHAQUE transition, de façon
 *     synchrone (`onCover`), avant toute autre réaction ;
 *   · aucune exception d'une dépendance ne laisse l'app bloquée : un échec
 *     de lecture du moyen de déverrouillage mène à l'écran de secours.
 *   · lot 111D : attente bornée de l'identité (`IDENTITY_WAIT_MS`), état de
 *     premier plan au démarrage, journal technique de chaque décision (codes
 *     stables, aucune donnée biométrique, aucun identifiant de compte).
 */
import { shouldLockOnResume, type PromptOutcome } from './app-lock';
import {
  IDENTITY_WAIT_MS, INITIAL_UNLOCK_STATE, isCovered, reduceUnlock,
  type PromptMode, type SessionKnown, type UnlockEffect, type UnlockEvent, type UnlockMethod, type UnlockState,
} from './unlock-machine';

export interface UnlockDeps {
  now(): number;
  readBackgroundAt(): number | null;
  persistBackgroundAt(at: number): void;
  clearBackgroundAt(): void;
  readMethod(userId: number | null): Promise<UnlockMethod>;
  prompt(mode: PromptMode): Promise<PromptOutcome>;
  /** Relit la session serveur (jamais depuis un cache) et rend l'état obtenu. */
  verifySession(): Promise<{ status: SessionKnown; userId: number | null }>;
  navigate(path: string): void;
  signInAgain(returnPath: string | null, reason?: 'mfa_required'): void;
  exitSession(): void;
  /** Masquage du contenu (synchrone). */
  onCover(covered: boolean): void;
  /** Journal sans secret (codes stables) — facultatif. */
  log?(code: string, detail?: Record<string, unknown>): void;
  /** Lot 111D : la page est-elle visible au démarrage ? (absent = oui). */
  isForeground?(): boolean;
  /** Lot 111D : minuterie injectable (tests) ; par défaut `setTimeout`. */
  setTimer?(ms: number, fn: () => void): void;
}

export interface UnlockController {
  getState(): UnlockState;
  subscribe(fn: (s: UnlockState) => void): () => void;
  dispatch(e: UnlockEvent): void;
  /** Démarrage (froid ou rechargement de la vue). */
  boot(): void;
  background(): void;
  resume(): void;
  /** Lot 111D : l'état natif lu au démarrage dit « arrière-plan » (vue rechargée par le système). */
  backgroundProbe(): void;
}

const NO_METHOD: UnlockMethod = { biometry: false, biometryAvailable: false, deviceSecure: false, whyNot: 'unavailable' };

export function createUnlockController(deps: UnlockDeps, initial: UnlockState = INITIAL_UNLOCK_STATE): UnlockController {
  let state = initial;
  let covered = isCovered(state);
  const listeners = new Set<(s: UnlockState) => void>();

  const run = (effects: UnlockEffect[]) => {
    for (const fx of effects) {
      switch (fx.type) {
        case 'persist_background': deps.persistBackgroundAt(fx.at); break;
        case 'clear_background': deps.clearBackgroundAt(); break;
        case 'read_method': {
          const userId = fx.userId;
          void deps.readMethod(userId)
            .catch((): UnlockMethod => ({ ...NO_METHOD, diag: { stored: 'read_failed' } }))
            .then((method) => {
              deps.log?.('UNLOCK_METHOD', {
                biometry: method.biometry, whyNot: method.whyNot ?? null,
                available: method.biometryAvailable, deviceSecure: method.deviceSecure, ...(method.diag ?? {}),
              });
              dispatch({ type: 'METHOD', userId, method });
            });
          break;
        }
        case 'await_identity': {
          const attempt = fx.attempt;
          deps.log?.('UNLOCK_AWAIT_IDENTITY', { attempt, session: state.session });
          (deps.setTimer ?? ((ms, fn) => { setTimeout(fn, ms); }))(IDENTITY_WAIT_MS, () => dispatch({ type: 'IDENTITY_TIMEOUT', attempt }));
          break;
        }
        case 'verify_session':
          void deps.verifySession()
            .catch(() => ({ status: 'temporarily-unavailable' as const, userId: state.userId }))
            .then((r) => dispatch({ type: 'SESSION_VERIFIED', status: r.status, userId: r.userId }));
          break;
        case 'prompt': {
          const attempt = fx.attempt;
          deps.log?.('UNLOCK_PROMPT', { mode: fx.mode, attempt });
          void deps.prompt(fx.mode)
            .catch((): PromptOutcome => 'failed')
            .then((outcome) => {
              deps.log?.('UNLOCK_PROMPT_RESULT', { mode: fx.mode, attempt, outcome });
              dispatch({ type: 'PROMPT_RESULT', attempt, outcome });
            });
          break;
        }
        case 'navigate': deps.navigate(fx.path); break;
        case 'sign_in_again': deps.log?.('UNLOCK_SIGN_IN', { reason: fx.reason ?? null }); if (fx.reason) deps.signInAgain(fx.returnPath, fx.reason); else deps.signInAgain(fx.returnPath); break;
        case 'exit_session': deps.exitSession(); break;
      }
    }
  };

  function dispatch(e: UnlockEvent): void {
    const before = state;
    const t = reduceUnlock(state, e);
    state = t.state;
    const c = isCovered(state);
    if (c !== covered) { covered = c; deps.onCover(c); }
    if (before.phase !== state.phase || before.fallback?.reason !== state.fallback?.reason) {
      deps.log?.('UNLOCK_PHASE', {
        from: before.phase, to: state.phase, event: e.type, session: state.session, foreground: state.foreground,
        ...(state.fallback ? { reason: state.fallback.reason, actions: state.fallback.actions.join(',') } : {}),
      });
    }
    if (state !== before) for (const fn of [...listeners]) fn(state);
    run(t.effects);
  }

  return {
    getState: () => state,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    dispatch,
    boot() {
      const foreground = deps.isForeground ? deps.isForeground() : true;
      const backgroundAt = deps.readBackgroundAt();
      const now = deps.now();
      deps.log?.('UNLOCK_BOOT', { foreground, lockDue: shouldLockOnResume(backgroundAt, now) });
      dispatch({ type: 'BOOT', now, backgroundAt, foreground });
      // Reprend la main sur le masque posé par le script de démarrage (même
      // tâche JavaScript : aucun affichage intermédiaire).
      deps.onCover(covered);
    },
    background() { dispatch({ type: 'BACKGROUND', now: deps.now() }); },
    resume() { dispatch({ type: 'RESUME', now: deps.now(), backgroundAt: deps.readBackgroundAt() }); },
    backgroundProbe() { dispatch({ type: 'BACKGROUND_PROBE', now: deps.now() }); },
  };
}
