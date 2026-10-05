/**
 * Source unique de l'identité côté navigateur — APP-PERF-02 / APP-PERF-04.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL CHARGEMENT, UN SEUL ÉTAT, POUR TOUS LES CONSOMMATEURS
 *
 * `useSession` tenait un état local par composant et appelait
 * `/api/users/me` à chaque montage : layout, page et panneaux lançaient
 * chacun leur lecture et pouvaient diverger. Ce magasin, porté par
 * `SessionProvider`, partage le chargement initial, les relectures et les
 * transitions (connexion, déconnexion, changement de compte, profil mis à
 * jour, révocation).
 *
 * ── QUATRE ÉTATS, ET NON « CHARGÉ / PAS CHARGÉ » ──────────────────────────
 *
 *   checking                : première vérification en cours ;
 *   authenticated           : le serveur a servi l'identité ;
 *   unauthenticated         : refus d'authentification DÉFINITIF (401 après
 *                             échec du renouvellement, compte suspendu) ;
 *   temporarily-unavailable : lenteur, 5xx, réseau, renouvellement en panne.
 *
 * Seul `unauthenticated` justifie un retour à la connexion. L'ancien
 * `Promise.race` de 4 s abandonnait `/api/users/me` et, sans utilisateur en
 * cache, le layout renvoyait à la connexion une session parfaitement valide.
 * Le délai est désormais celui du client HTTP commun (`HTTP_POLICIES.read`).
 *
 * ── CE QUI N'EST PAS UNE PREUVE D'AUTHENTIFICATION ────────────────────────
 *
 * Le cookie de session est HttpOnly : il ne se teste pas en JavaScript
 * (l'ancien `hasToken = true` était une pseudo-vérification). L'état vient du
 * serveur. La copie `localStorage.user` n'est plus lue pour le premier rendu
 * (rendu serveur/client identique, aucune ancienne identité affichée comme
 * autoritaire) ; elle reste écrite pour les écrans qui s'en servent comme
 * confort d'affichage. La dernière identité obtenue DANS CE CONTEXTE est
 * conservée pendant une indisponibilité : c'est un affichage, jamais un droit.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { UserRole, PlanType, SubscriptionStatus } from '@/types/domain';

export interface User {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  username?: string | null;
  accountName?: string;
  role: UserRole;
  subscription: {
    plan: PlanType;
    status: SubscriptionStatus;
    /** État d'essai servi par `/api/users/me`. N'accorde aucun droit. */
    trialStatus?: 'none' | 'active' | 'expired' | 'converted';
    trialDaysLeft?: number | null;
    isTrial?: boolean;
  };
  duoId?: number;
  /** UNPAID_RECOVERY : impayé Duo, restreint dès l'échec (aucune grâce). */
  duoStatus?: 'ACTIVE' | 'UNPAID_RECOVERY' | 'CANCELED';
  duoRole?: 'BILLING_OWNER' | 'MEMBER';
  duoActivatedAt?: string;
  /** Impayé Duo : fin du délai de récupération des biens. N'ouvre aucun droit. */
  unpaidRecoveryEndsAt?: string;
  duoEntitlement?: boolean;
  isInRecovery?: boolean;
}

export type SessionStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'temporarily-unavailable';

/** Erreur de session typée, exposée au shell. */
export interface SessionError {
  kind: 'unauthenticated' | 'unavailable';
  /** Code stable (AUTH_REQUIRED, ACCOUNT_SUSPENDED, REQUEST_TIMEOUT, SIGNED_OUT…). */
  code: string;
  status: number;
  message: string;
  requestId?: string;
}

export interface SessionSnapshot {
  status: SessionStatus;
  /** Identité servie par le serveur dans ce contexte (conservée si indisponible). */
  user: User | null;
  error: SessionError | null;
}

export const INITIAL_SESSION_SNAPSHOT: SessionSnapshot = Object.freeze({
  status: 'checking',
  user: null,
  error: null,
}) as SessionSnapshot;

/** Code posé après une déconnexion volontaire : la navigation est déjà gérée. */
export const SIGNED_OUT_CODE = 'SIGNED_OUT';

/** Refus d'authentification définitifs (après échec du renouvellement). */
const UNAUTHENTICATED_CODES = new Set([
  'UNAUTHORIZED', 'AUTH_REQUIRED', 'INVALID_TOKEN', 'TOKEN_EXPIRED', 'ACCOUNT_SUSPENDED',
]);

/**
 * Classe une erreur de `/api/users/me`. Fondée sur le statut HTTP et le code
 * stable, jamais sur un message libre.
 */
export function classifySessionError(err: unknown): SessionError {
  const e = (err ?? {}) as { status?: number; code?: string; message?: string; requestId?: string };
  const status = typeof e.status === 'number' ? e.status : 0;
  const code = typeof e.code === 'string' && e.code ? e.code : 'UNKNOWN_ERROR';
  if (status === 401 || (status === 403 && code === 'ACCOUNT_SUSPENDED') || (status !== 0 && status < 500 && UNAUTHENTICATED_CODES.has(code))) {
    return { kind: 'unauthenticated', code, status, message: 'Votre session a expiré. Merci de vous reconnecter.', requestId: e.requestId };
  }
  return {
    kind: 'unavailable',
    code,
    status,
    message: 'Le service est momentanément indisponible. Vos données sont intactes : réessayez dans un instant.',
    requestId: e.requestId,
  };
}

export interface SessionStoreDeps {
  /** Lecture de l'identité ; doit honorer `signal`. */
  fetchMe: (signal: AbortSignal) => Promise<User>;
  /** Copie d'affichage (localStorage) ; absente côté serveur et en test. */
  persist?: (user: User | null) => void;
  /**
   * Le serveur sert un AUTRE utilisateur que celui affiché (changement de
   * compte sur le même appareil) : les caches de l'ancien contexte sont à purger.
   */
  onIdentityChange?: () => void;
}

export class SessionStore {
  private snapshot: SessionSnapshot = INITIAL_SESSION_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  /** Génération : une réponse d'une génération antérieure est ignorée. */
  private generation = 0;
  private inFlight: { generation: number; promise: Promise<void>; controller: AbortController } | null = null;
  private loadedOnce = false;
  private retainers = 0;

  constructor(private readonly deps: SessionStoreDeps) {}

  getSnapshot = (): SessionSnapshot => this.snapshot;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  private set(next: SessionSnapshot): void {
    if (next.status === this.snapshot.status && next.user === this.snapshot.user && next.error === this.snapshot.error) return;
    this.snapshot = next;
    for (const fn of [...this.listeners]) fn();
  }

  /**
   * Un consommateur a besoin de l'identité : premier chargement si
   * nécessaire. Rend la fonction de libération.
   */
  retain(): () => void {
    this.retainers += 1;
    void this.ensureLoaded();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.retainers -= 1;
    };
  }

  /** Chargement initial, une seule fois par contexte (hors reprise explicite). */
  ensureLoaded(): Promise<void> {
    if (this.inFlight) return this.inFlight.promise;
    if (this.loadedOnce) return Promise.resolve();
    // Après une déconnexion volontaire, pas de relecture implicite.
    if (this.snapshot.error?.code === SIGNED_OUT_CODE) return Promise.resolve();
    return this.refetch();
  }

  /**
   * Relit l'identité. Les appels concurrents partagent la même lecture
   * (CA-01 : pas de chargements `/api/users/me` identiques en parallèle).
   */
  refetch(): Promise<void> {
    if (this.inFlight && this.inFlight.generation === this.generation) return this.inFlight.promise;
    const generation = this.generation;
    const controller = new AbortController();
    let settled = false;
    const promise = (async () => {
      try {
        const user = await this.deps.fetchMe(controller.signal);
        if (generation !== this.generation) return;
        this.loadedOnce = true;
        const previous = this.snapshot.user;
        if (previous && previous.id !== user.id) this.deps.onIdentityChange?.();
        this.set({ status: 'authenticated', user, error: null });
        this.deps.persist?.(user);
      } catch (err) {
        if (generation !== this.generation) return;
        this.loadedOnce = true;
        const error = classifySessionError(err);
        if (error.kind === 'unauthenticated') {
          // Session invalide : l'identité est purgée, pas seulement masquée.
          this.set({ status: 'unauthenticated', user: null, error });
          this.deps.persist?.(null);
        } else {
          // Lenteur, 5xx, réseau : la dernière identité de CE contexte reste
          // affichable ; aucun droit nouveau n'en découle.
          this.set({ status: 'temporarily-unavailable', user: this.snapshot.user, error });
        }
      } finally {
        settled = true;
        if (this.inFlight?.controller === controller) this.inFlight = null;
      }
    })();
    // Lecture déjà terminée (échec synchrone) : rien à partager.
    if (!settled) this.inFlight = { generation, promise, controller };
    return promise;
  }

  /** Profil enregistré ailleurs : tous les consommateurs voient la mise à jour. */
  applyProfileUpdate(patch: Partial<User>): void {
    const current = this.snapshot.user;
    // Sans identité courante (session terminée), une mise à jour tardive ne
    // doit pas en recréer une.
    if (!current || (patch.id !== undefined && patch.id !== current.id)) return;
    const user = { ...current, ...patch, subscription: { ...current.subscription, ...(patch.subscription ?? {}) } };
    this.set({ ...this.snapshot, user });
    this.deps.persist?.(user);
  }

  /**
   * Transition de session. `logout` / `auth-failure` : identité purgée, aucune
   * relecture (la procédure de sortie gère la navigation). `login` /
   * `account-change` : retour à `checking`, relecture si un consommateur est
   * monté. Dans tous les cas, une lecture en cours est abandonnée et sa
   * réponse tardive ignorée.
   */
  reset(reason: 'login' | 'logout' | 'auth-failure' | 'account-change'): void {
    this.generation += 1;
    this.inFlight?.controller.abort();
    this.inFlight = null;
    this.loadedOnce = false;
    if (reason === 'logout' || reason === 'auth-failure') {
      this.set({
        status: 'unauthenticated',
        user: null,
        error: reason === 'logout'
          ? { kind: 'unauthenticated', code: SIGNED_OUT_CODE, status: 0, message: 'Déconnexion en cours.' }
          : { kind: 'unauthenticated', code: 'UNAUTHORIZED', status: 401, message: 'Votre session a expiré. Merci de vous reconnecter.' },
      });
      return;
    }
    this.set(INITIAL_SESSION_SNAPSHOT);
    if (this.retainers > 0) void this.refetch();
  }
}
