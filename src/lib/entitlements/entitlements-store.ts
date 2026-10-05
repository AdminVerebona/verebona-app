/**
 * État des droits partagé par toute l'interface — APP-PERF-12.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE LECTURE, UN ÉTAT, PAR CONTEXTE DE SESSION
 *
 * `useEntitlements` tenait ses refs de chargement et de fraîcheur PAR
 * INSTANCE, et appelait `/api/billing/trial-status` en `fetch` direct :
 * WriteGuard, layout, panneau « Ajouter » et pages relançaient chacun la même
 * lecture lourde, et pouvaient afficher des droits différents. Ce magasin,
 * porté par `EntitlementsProvider`, n'en fait qu'une et la partage.
 *
 * ── LIÉ AU COMPTE COURANT ─────────────────────────────────────────────────
 *
 * Chaque transition de session (connexion, déconnexion, refus définitif,
 * changement de compte) vide les droits et ignore toute réponse tardive :
 * aucun droit de l'ancien compte n'est réutilisé (T-03).
 *
 * ── INCONNU N'EST PAS REFUSÉ ──────────────────────────────────────────────
 *
 *   unknown     : jamais obtenus dans ce contexte (ou session terminée) ;
 *   known       : servis par le serveur ;
 *   unavailable : la dernière lecture a échoué temporairement (5xx, réseau,
 *                 renouvellement en panne) — la dernière valeur connue est
 *                 conservée, une nouvelle lecture sera tentée.
 *
 * Une erreur temporaire n'accorde aucun droit et n'ouvre aucune fenêtre
 * commerciale. Le contrôle qui fait foi reste le contrôle serveur.
 * ══════════════════════════════════════════════════════════════════════════
 */

export interface QuotaUsage {
  used: number;
  limit: number;
  ratio: number;
  label: string;
  shouldWarn: boolean;
  isFull: boolean;
}

export interface EntitlementsState {
  plan: string;
  status: string;
  canWrite: boolean;
  isRestricted: boolean;
  premiumFeatures: boolean;
  quotas: {
    assets: QuotaUsage;
    documents: QuotaUsage;
    users: { limit: number };
  };
  trial: {
    status: 'none' | 'active' | 'expired' | 'converted';
    daysRemaining: number;
    endsAt: string | null;
    isUrgent: boolean;
    dejaConsomme: boolean;
  };
  /** Cycle d'impayé en cours (paiement échoué), `null` sinon. */
  unpaid?: { startedAt: string; deadlineAt: string; daysLeft: number } | null;
}

export type EntitlementsStatus = 'unknown' | 'known' | 'unavailable';

export interface EntitlementsSnapshot {
  data: EntitlementsState | null;
  status: EntitlementsStatus;
  /** Vrai tant qu'aucune réponse n'a été obtenue dans ce contexte. */
  isLoading: boolean;
}

export const INITIAL_ENTITLEMENTS_SNAPSHOT: EntitlementsSnapshot = Object.freeze({
  data: null,
  status: 'unknown',
  isLoading: true,
}) as EntitlementsSnapshot;

/** Au-delà, les droits sont relus au prochain changement de page. */
export const DUREE_VALIDITE_MS = 60_000;

export interface EntitlementsStoreDeps {
  /** Lecture des droits ; doit honorer `signal`. */
  fetchEntitlements: (signal: AbortSignal) => Promise<EntitlementsState>;
  now?: () => number;
}

/** Refus définitif de session : les droits précédents ne valent plus. */
function isSessionRefusal(err: unknown): boolean {
  const e = (err ?? {}) as { status?: number; code?: string };
  return e.status === 401 || e.status === 404
    || (e.status === 403 && (e.code === 'ACCOUNT_SUSPENDED' || e.code === 'ACCOUNT_PENDING_DELETION'));
}

function isAbort(err: unknown): boolean {
  return (err as { code?: string })?.code === 'REQUEST_ABORTED' || (err as Error)?.name === 'AbortError';
}

export class EntitlementsStore {
  private snapshot: EntitlementsSnapshot = INITIAL_ENTITLEMENTS_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private inFlight: { generation: number; promise: Promise<void>; controller: AbortController } | null = null;
  /** Date de la dernière lecture réussie ; `null` : jamais obtenus / périmés. */
  private loadedAt: number | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: EntitlementsStoreDeps) {
    this.now = deps.now ?? Date.now;
  }

  getSnapshot = (): EntitlementsSnapshot => this.snapshot;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  private set(patch: Partial<EntitlementsSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    if (next.data === this.snapshot.data && next.status === this.snapshot.status && next.isLoading === this.snapshot.isLoading) return;
    this.snapshot = next;
    for (const fn of [...this.listeners]) fn();
  }

  /** Les droits ont-ils plus de `maxAgeMs` (ou n'ont-ils jamais été obtenus) ? */
  isStale(maxAgeMs: number = DUREE_VALIDITE_MS): boolean {
    return this.loadedAt === null || this.now() - this.loadedAt > maxAgeMs;
  }

  /** Relit les droits. Les appels concurrents partagent la même lecture (CA-01). */
  refresh(): Promise<void> {
    if (this.inFlight && this.inFlight.generation === this.generation) return this.inFlight.promise;
    const generation = this.generation;
    const controller = new AbortController();
    let settled = false;
    const promise = (async () => {
      try {
        const data = await this.deps.fetchEntitlements(controller.signal);
        if (generation !== this.generation) return;
        if (data && !(data as { error?: unknown }).error) {
          this.loadedAt = this.now();
          this.set({ data, status: 'known', isLoading: false });
        } else {
          this.set({ status: 'unavailable', isLoading: false });
        }
      } catch (err) {
        if (generation !== this.generation || isAbort(err)) return;
        if (isSessionRefusal(err)) {
          // Deconnecte : les droits precedents ne valent plus.
          this.loadedAt = null;
          this.set({ data: null, status: 'unknown', isLoading: false });
        } else {
          // Panne temporaire : on garde la derniere valeur connue, sans en
          // accorder de nouvelle ; `loadedAt` inchangé → nouvelle lecture
          // au prochain déclencheur.
          this.set({ status: 'unavailable', isLoading: false });
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

  /** `refresh` à identité stable, pour les dépendances d'effets React. */
  refreshBound = (): Promise<void> => this.refresh();

  /** Relit seulement si les droits sont inconnus ou anciens. */
  refreshIfStale(maxAgeMs: number = DUREE_VALIDITE_MS): Promise<void> {
    return this.isStale(maxAgeMs) ? this.refresh() : Promise.resolve();
  }

  /** Les droits ne sont plus frais (écriture, quota) : relus au prochain déclencheur. */
  markStale(): void {
    this.loadedAt = null;
  }

  /** Page sans session : rien à attendre. */
  markIdle(): void {
    if (this.snapshot.isLoading && !this.inFlight) this.set({ isLoading: false });
  }

  /**
   * Changement de contexte de session : droits vidés, lecture en cours
   * abandonnée, réponse tardive ignorée.
   */
  reset(opts: { idle?: boolean } = {}): void {
    this.generation += 1;
    this.inFlight?.controller.abort();
    this.inFlight = null;
    this.loadedAt = null;
    // `idle` : session terminée, aucune lecture ne suivra.
    this.set({ ...INITIAL_ENTITLEMENTS_SNAPSHOT, isLoading: !opts.idle });
  }
}
