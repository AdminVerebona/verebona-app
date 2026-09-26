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
 *   · sur l'evenement `entitlements:refresh` (connexion, souscription…).
 * ══════════════════════════════════════════════════════════════════════════
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { isUnpaid } from '@/lib/trial-status';

/** Evenement a emettre apres un changement de droits (connexion, offre). */
export const ENTITLEMENTS_REFRESH_EVENT = 'entitlements:refresh';

/** Au-dela, les droits sont relus au prochain changement de page. */
const DUREE_VALIDITE_MS = 60_000;

/** Pages publiques : inutile d'interroger les droits sans session. */
const PAGES_SANS_SESSION = ['/login', '/signup', '/forgot-password', '/reset-password'];

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

export function useEntitlements() {
  const pathname = usePathname();
  const [data, setData] = useState<EntitlementsState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const chargeLe = useRef(0);
  const enCours = useRef(false);
  const monte = useRef(true);

  const refresh = useCallback(async () => {
    if (enCours.current) return;
    enCours.current = true;
    try {
      const r = await fetch('/api/billing/trial-status', { credentials: 'include', cache: 'no-store' });
      const d = r.ok ? await r.json() : null;
      if (!monte.current) return;
      if (d && !d.error) {
        setData(d as EntitlementsState);
        chargeLe.current = Date.now();
      } else if (r.status === 401) {
        // Deconnecte : les droits precedents ne valent plus.
        setData(null);
        chargeLe.current = 0;
      }
    } catch {
      /* reseau : on garde la derniere valeur connue */
    } finally {
      enCours.current = false;
      if (monte.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    monte.current = true;
    return () => { monte.current = false; };
  }, []);

  // Premier chargement, puis a chaque page tant que les droits sont
  // inconnus ou anciens.
  useEffect(() => {
    if (pathname && PAGES_SANS_SESSION.some((p) => pathname.startsWith(p))) {
      setIsLoading(false);
      return;
    }
    if (Date.now() - chargeLe.current > DUREE_VALIDITE_MS) void refresh();
  }, [pathname, refresh]);

  // Retour sur l'application et demande explicite.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden && Date.now() - chargeLe.current > DUREE_VALIDITE_MS) void refresh();
    };
    const onRefresh = () => { void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(ENTITLEMENTS_REFRESH_EVENT, onRefresh);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(ENTITLEMENTS_REFRESH_EVENT, onRefresh);
    };
  }, [refresh]);

  return {
    entitlements: data,
    isLoading,
    /** Relit les droits aupres du serveur. */
    refresh,
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
