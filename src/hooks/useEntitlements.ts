/**
 * Droits effectifs du compte, cote client.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE HOOK PLUTOT QUE `useFeatureFlags`
 *
 * `useFeatureFlags` deduit les droits du seul `planType` porte par la
 * session. Il ignore l'etat reel de l'abonnement : un compte dont l'essai
 * est termine conserve son plan `PREMIUM` dans le jeton, donc ses limites,
 * donc ses boutons actifs. L'interface invitait ainsi a remplir un
 * formulaire que le serveur allait refuser.
 *
 * `/api/billing/trial-status` renvoie les droits calcules par
 * `entitlements.service` — la meme source que celle qui autorise ou refuse
 * l'ecriture. C'est elle qu'il faut interroger pour decider ce que
 * l'interface propose.
 *
 * Ce hook n'AUTORISE rien : il evite un aller-retour inutile et permet
 * d'annoncer le refus AVANT la saisie. Le controle qui fait foi reste le
 * controle serveur.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DES DROITS LUS UNE SEULE FOIS RESTAIENT VIDES TOUTE LA SESSION
 *
 * `WriteGuardProvider` est monte a la racine, AVANT la connexion. La lecture
 * unique, au montage, partait donc sur `/login` sans session : 401, droits
 * `null`, et la garde laisse passer quand les droits sont inconnus.
 *
 * Aucune navigation cliente ne relisait les droits. Jusqu'au prochain
 * rechargement complet, TOUTES les actions passaient — d'ou des resultats
 * de recette contradictoires, en particulier sur mobile ou l'application
 * installee ne se recharge presque jamais.
 *
 * Les droits sont maintenant relus :
 *   · a chaque changement de page tant qu'ils sont inconnus ou anciens ;
 *   · au retour sur l'application (onglet ou PWA remise au premier plan) ;
 *   · sur l'evenement `entitlements:refresh` (connexion, souscription…) ;
 *   · apres une ecriture reussie (quotas), regroupees ;
 *   · a chaque transition de session (connexion, changement de compte) ;
 *     une deconnexion les vide.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL ETAT POUR TOUS — APP-PERF-12
 *
 * Ces relectures sont portees UNE fois par `EntitlementsProvider` (monte dans
 * `ClientShell`, au-dessus de la garde d'ecriture) sur un magasin partage
 * (`lib/entitlements/entitlements-store.ts`). Chaque `useEntitlements` lit ce
 * meme etat : une lecture pour la garde, le layout, les panneaux et les pages.
 * La lecture passe par le client HTTP commun : renouvellement de session
 * partage et budget borne — un 401 provisoire (PWA reveillee, cookie d'acces
 * expire) ne fige plus des droits `null` jusqu'a la prochaine navigation.
 * ══════════════════════════════════════════════════════════════════════════
 */
'use client';

import { createContext, createElement, useContext, useEffect, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { isUnpaid } from '@/lib/trial-status';
import { apiClient } from '@/lib/api-client';
import { onSessionTransition } from '@/lib/session/session-lifecycle';
import { isPageSansSession } from '@/contexts/SessionContext';
import {
  DUREE_VALIDITE_MS,
  EntitlementsStore,
  INITIAL_ENTITLEMENTS_SNAPSHOT,
  type EntitlementsState,
} from '@/lib/entitlements/entitlements-store';

export type { EntitlementsState, QuotaUsage, EntitlementsStatus } from '@/lib/entitlements/entitlements-store';

/** Evenement a emettre apres un changement de droits (connexion, offre). */
export const ENTITLEMENTS_REFRESH_EVENT = 'entitlements:refresh';

/** Regroupement des relectures apres une rafale d'ecritures. */
const DELAI_APRES_ECRITURE_MS = 2_000;

let defaultStore: EntitlementsStore | null = null;

/** Magasin du navigateur (un par onglet). */
export function getEntitlementsStore(): EntitlementsStore {
  if (defaultStore) return defaultStore;
  const store = new EntitlementsStore({
    // Lecture partagée ; `silent` : sur une page publique sans session, un
    // refus ne doit pas déclencher de redirection — les droits restent inconnus.
    fetchEntitlements: (signal) => apiClient.get<EntitlementsState>('/api/billing/trial-status', {
      signal, dedupe: true, onAuthFailure: 'silent',
    }),
  });
  defaultStore = store;
  return store;
}

const EntitlementsContext = createContext<EntitlementsStore | null>(null);

function useEntitlementsStore(): EntitlementsStore {
  return useContext(EntitlementsContext) ?? getEntitlementsStore();
}

/**
 * Fournisseur unique des droits. Porte toutes les relectures ; les
 * consommateurs ne font que lire.
 */
export function EntitlementsProvider({ children, store: injected }: { children: React.ReactNode; store?: EntitlementsStore }) {
  const store = injected ?? getEntitlementsStore();
  const pathname = usePathname();

  // Premier chargement, puis a chaque page tant que les droits sont
  // inconnus ou anciens.
  useEffect(() => {
    if (isPageSansSession(pathname)) {
      store.markIdle();
      return;
    }
    void store.refreshIfStale(DUREE_VALIDITE_MS);
  }, [pathname, store]);

  // Transitions de session : aucun droit de l'ancien contexte n'est conservé.
  useEffect(() => onSessionTransition((t) => {
    const sortie = t.reason === 'logout' || t.reason === 'auth-failure';
    store.reset({ idle: sortie });
    if (!sortie && !isPageSansSession(window.location.pathname)) void store.refresh();
  }), [store]);

  // Retour sur l'application, demande explicite, ecritures reussies.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onVisible = () => {
      if (!document.hidden && !isPageSansSession(window.location.pathname)) void store.refreshIfStale(DUREE_VALIDITE_MS);
    };
    const onRefresh = () => { void store.refresh(); };
    const onMutated = () => {
      // Quota consommé ou libéré : droits périmés, relus une fois la rafale passée.
      store.markStale();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { if (!document.hidden) void store.refreshIfStale(0); }, DELAI_APRES_ECRITURE_MS);
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(ENTITLEMENTS_REFRESH_EVENT, onRefresh);
    window.addEventListener('online', onVisible);
    window.addEventListener('verebona:data-mutated', onMutated);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(ENTITLEMENTS_REFRESH_EVENT, onRefresh);
      window.removeEventListener('online', onVisible);
      window.removeEventListener('verebona:data-mutated', onMutated);
      if (timer) clearTimeout(timer);
    };
  }, [store]);

  return createElement(EntitlementsContext.Provider, { value: store }, children);
}

const serverSnapshot = () => INITIAL_ENTITLEMENTS_SNAPSHOT;

export function useEntitlements() {
  const store = useEntitlementsStore();
  const { data, isLoading, status } = useSyncExternalStore(store.subscribe, store.getSnapshot, serverSnapshot);

  return {
    entitlements: data,
    isLoading,
    /** Droits inconnus (`unknown`), servis (`known`) ou derniere lecture en echec (`unavailable`). */
    status,
    /** Relit les droits aupres du serveur. */
    refresh: store.refreshBound,
    /** Ecriture bloquee par les droits (essai termine, offre resiliee, impaye). */
    isRestricted: data?.isRestricted ?? false,
    /** Restriction due a un paiement echoue (≠ fin d'essai) — voir `isUnpaid`. */
    isUnpaid: isUnpaid(data),
    /** Quota de biens atteint — distinct du mode restreint. */
    isAssetQuotaFull: data?.quotas?.assets?.isFull ?? false,
    /** Quota de documents atteint. */
    isDocumentQuotaFull: data?.quotas?.documents?.isFull ?? false,
  };
}
