'use client';

/**
 * Identité de l'utilisateur connecté — lecture du `SessionProvider`.
 *
 * Signature publique conservée (`user`, `isLoading`, `error`, `refetch`) pour
 * les consommateurs existants ; s'y ajoutent l'état explicite (`status`) et
 * l'erreur typée (`sessionError`) — APP-PERF-02 / APP-PERF-04.
 *
 * Le hook ne lance plus de lecture propre : il s'abonne au magasin partagé et
 * déclenche au besoin son chargement initial (une seule lecture pour tous).
 *
 * `required` : sur un refus d'authentification DÉFINITIF seulement, la
 * procédure de sortie unique (`apiClient.handleAuthFailure`) renvoie à la
 * connexion, chemin et paramètres conservés — depuis un effet, jamais pendant
 * le rendu. Une lenteur ou une panne laisse l'état `temporarily-unavailable`,
 * réessayable, sans effacer l'identité.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { apiClient } from '@/lib/api-client';
import { useSessionStore } from '@/contexts/SessionContext';
import {
  INITIAL_SESSION_SNAPSHOT,
  SIGNED_OUT_CODE,
  type SessionError,
  type SessionStatus,
  type User,
} from '@/lib/session/session-store';

export type { User, SessionError, SessionStatus } from '@/lib/session/session-store';

interface UseSessionOptions {
  required?: boolean;
  /**
   * Conservé pour compatibilité. La destination d'un refus définitif est
   * celle de la procédure de sortie unique (`/login?expired=1&returnUrl=…`).
   */
  redirectTo?: string;
}

interface UseSessionReturn {
  user: User | null;
  isLoading: boolean;
  /** Message lisible de la dernière erreur, ou `null`. */
  error: string | null;
  /** État explicite de la session. */
  status: SessionStatus;
  /** Erreur typée (refus définitif ou indisponibilité temporaire). */
  sessionError: SessionError | null;
  refetch: () => Promise<void>;
}

const serverSnapshot = () => INITIAL_SESSION_SNAPSHOT;

/**
 * Lot 103A — la procédure de sortie n'est lancée que sur un refus DÉFINITIF
 * encore actuel : magasin « non authentifié » au moment de décider, hors
 * déconnexion volontaire (pur, testé).
 */
export function shouldExitOnAuthFailure(
  live: { status: SessionStatus; error: SessionError | null },
  signingOut: boolean,
): boolean {
  if (live.status !== 'unauthenticated') return false;
  if (live.error?.code === SIGNED_OUT_CODE || signingOut) return false;
  return true;
}

export function useSession(
  options: UseSessionOptions = {}
): UseSessionReturn {
  const { required = false } = options;
  const store = useSessionStore();
  // Premier rendu identique côté serveur et client (`checking`) : aucune
  // identité lue dans le localStorage avant hydratation.
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, serverSnapshot);

  // Chargement initial partagé : le premier consommateur le lance, les
  // suivants le rejoignent.
  useEffect(() => store.retain(), [store]);

  const { status, error } = snapshot;
  useEffect(() => {
    if (!required || status !== 'unauthenticated') return;
    // Lot 103A — l'état lu au RENDU peut être périmé : après une connexion par
    // navigation client (formulaire e-mail / mot de passe, vérification
    // d'adresse), la page protégée est rendue avec l'état « non authentifié »
    // laissé par la page de connexion (dans l'app, `NativeBridgeRuntime` lit
    // la session dès l'écran de connexion), puis le fournisseur ouvre la
    // nouvelle époque (effet de mise en page) AVANT cet effet. Décider sur
    // l'état ACTUEL du magasin : sinon la procédure de sortie révoquait la
    // session tout juste ouverte et renvoyait à « Votre session a expiré ».
    const live = store.getSnapshot();
    if (!shouldExitOnAuthFailure(live, apiClient.isSigningOut())) return;
    void apiClient.handleAuthFailure({ code: live.error?.code });
  }, [required, status, error, store]);

  // Référence STABLE (lot 24) : une fonction recréée à chaque rendu, placée
  // dans les dépendances d'un effet, relançait cet effet à chaque rendu
  // (ex. retour Stripe de « Offres » : synchronisation lancée plusieurs fois).
  const refetch = useCallback(() => store.refetch(), [store]);

  return {
    user: snapshot.user,
    isLoading: status === 'checking',
    error: error?.message ?? null,
    status,
    sessionError: error,
    refetch,
  };
}
