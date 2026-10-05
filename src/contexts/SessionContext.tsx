'use client';

/**
 * Fournisseur de session unique — APP-PERF-04.
 *
 * Monté une fois dans `ClientShell` : tous les consommateurs de `useSession`
 * (layout, pages, panneaux, `useFeatureFlags`, droits) lisent le même
 * magasin (`lib/session/session-store.ts`) au lieu de lancer chacun leur
 * propre lecture de `/api/users/me`.
 *
 * Le fournisseur porte aussi les transitions qui ne dépendent d'aucun écran :
 *   · retour d'une page d'authentification (connexion, inscription par
 *     navigation client, sans rechargement) → nouvelle époque, relecture ;
 *   · profil enregistré ailleurs (`user-profile-updated`) ;
 *   · reprise après indisponibilité : retour du réseau ou de l'application
 *     au premier plan.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { apiClient } from '@/lib/api-client';
import { beginSessionTransition, onSessionTransition } from '@/lib/session/session-lifecycle';
import { SessionStore, type User } from '@/lib/session/session-store';

/** Pages où aucune session n'est attendue (même liste que les droits). */
export const PAGES_SANS_SESSION = ['/login', '/signup', '/forgot-password', '/reset-password', '/verify-email'];

export function isPageSansSession(pathname: string | null | undefined): boolean {
  return Boolean(pathname && PAGES_SANS_SESSION.some((p) => pathname.startsWith(p)));
}

function persistDisplayCopy(user: User | null): void {
  if (typeof window === 'undefined') return;
  try {
    // Confort d'affichage pour quelques écrans ; jamais relu comme preuve
    // d'authentification ni pour le premier rendu.
    if (user) window.localStorage.setItem('user', JSON.stringify(user));
    else window.localStorage.removeItem('user');
  } catch { /* stockage indisponible */ }
}

let defaultStore: SessionStore | null = null;

/** Magasin du navigateur (un par onglet). */
export function getSessionStore(): SessionStore {
  if (defaultStore) return defaultStore;
  const store = new SessionStore({
    // Délai et nouvelles tentatives du client HTTP commun ; lecture partagée ;
    // la décision de rediriger revient au shell (`useSession({ required })`).
    fetchMe: (signal) => apiClient.get<User>('/api/users/me', { signal, dedupe: true, onAuthFailure: 'silent' }),
    persist: persistDisplayCopy,
    onIdentityChange: () => { beginSessionTransition('account-change'); },
  });
  onSessionTransition((t) => {
    // `account-change` est émis par le magasin lui-même, qui a déjà la
    // nouvelle identité : seuls les autres caches sont à purger.
    if (t.reason !== 'account-change') store.reset(t.reason);
  });
  defaultStore = store;
  return store;
}

const SessionContext = createContext<SessionStore | null>(null);

/** Magasin de session du contexte (le fournisseur, sinon celui du navigateur). */
export function useSessionStore(): SessionStore {
  return useContext(SessionContext) ?? getSessionStore();
}

export function SessionProvider({ children, store: injected }: { children: React.ReactNode; store?: SessionStore }) {
  const store = injected ?? getSessionStore();
  const pathname = usePathname();
  const precedente = useRef<string | null>(null);

  // Sortie d'une page d'authentification par navigation client : la session
  // a pu naître ou changer sans rechargement. Rien de l'ancien contexte
  // (identité, droits, réponses en cache) n'est réutilisé. Effet de mise en
  // page : la transition précède les effets des consommateurs, qui partent
  // donc directement dans le nouveau contexte.
  useLayoutEffect(() => {
    const avant = precedente.current;
    precedente.current = pathname;
    if (avant !== null && isPageSansSession(avant) && !isPageSansSession(pathname)) {
      beginSessionTransition('login');
    }
  }, [pathname]);

  useEffect(() => {
    const onProfile = (e: Event) => {
      const updated = (e as CustomEvent<Partial<User>>).detail;
      if (updated) store.applyProfileUpdate(updated);
    };
    // Reprise explicite après indisponibilité, jamais en boucle.
    const reprendre = () => {
      if (store.getSnapshot().status === 'temporarily-unavailable') void store.refetch();
    };
    const onVisible = () => { if (!document.hidden) reprendre(); };
    window.addEventListener('user-profile-updated', onProfile);
    window.addEventListener('online', reprendre);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('user-profile-updated', onProfile);
      window.removeEventListener('online', reprendre);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [store]);

  return <SessionContext.Provider value={store}>{children}</SessionContext.Provider>;
}
