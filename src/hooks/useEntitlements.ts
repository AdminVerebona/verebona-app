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
 */
'use client';

import { useEffect, useState } from 'react';

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
}

export function useEntitlements() {
  const [data, setData] = useState<EntitlementsState | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let annule = false;
    fetch('/api/billing/trial-status', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!annule && d && !d.error) setData(d as EntitlementsState);
      })
      .catch(() => {})
      .finally(() => {
        if (!annule) setIsLoading(false);
      });
    return () => {
      annule = true;
    };
  }, []);

  return {
    entitlements: data,
    isLoading,
    /** Ecriture bloquee par les droits (essai termine, offre resiliee). */
    isRestricted: data?.isRestricted ?? false,
    /** Quota de biens atteint — distinct du mode restreint. */
    isAssetQuotaFull: data?.quotas?.assets?.isFull ?? false,
    /** Quota de documents atteint. */
    isDocumentQuotaFull: data?.quotas?.documents?.isFull ?? false,
  };
}
