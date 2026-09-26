'use client';

/**
 * Impayé en cours — message et geste de régularisation (Centre d'aide
 * GAP-06, AID-BILL-008 ; cycle défini dans `unpaid-cycle.rules.ts`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN COMPOSANT DÉDIÉ
 *
 * Tout compte restreint était présenté comme « essai terminé ». Pour un
 * client dont le paiement a échoué, ce message est faux (il a payé jusque-là,
 * « aucun prélèvement » est inexact) et oriente vers le mauvais geste
 * (choisir une offre qu'il a déjà). Il doit lire, partout où la restriction
 * s'annonce — bandeau, « Mon abonnement », page des offres :
 *   · ce qui s'est passé : le paiement a échoué ;
 *   · la date limite de régularisation, et ce qui arrive après ;
 *   · ce qui reste possible : consulter, exporter, transmettre ;
 *   · le geste : mettre à jour le moyen de paiement (portail Stripe existant).
 * Un seul composant, pour que ces quatre éléments ne divergent pas.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useState } from 'react';
import { AlertTriangle, CreditCard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { openBillingPortal } from '@/lib/billing/open-billing-portal';
import { unpaidDeadlineLabel, type UnpaidCyclePayload } from '@/lib/trial-status';

/** Libellé du bouton — le même partout (bandeau, fenêtre, pages). */
export const UPDATE_PAYMENT_METHOD_LABEL = 'Mettre à jour le moyen de paiement';

interface Props {
  unpaid: UnpaidCyclePayload;
  /** `banner` : bandeau pleine largeur en tête d'écran ; `card` : encadré. */
  variant?: 'banner' | 'card';
}

export function UnpaidPaymentNotice({ unpaid, variant = 'card' }: Props) {
  const [loading, setLoading] = useState(false);
  const echeance = unpaidDeadlineLabel(unpaid);

  const regulariser = async () => {
    setLoading(true);
    try {
      await openBillingPortal();
    } finally {
      setLoading(false);
    }
  };

  const conteneur =
    variant === 'banner'
      ? 'flex flex-wrap items-center gap-3 border-b border-red-500/30 bg-red-500/10 px-4 py-3'
      : 'mb-5 flex flex-wrap items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-3';

  return (
    <div className={conteneur} role="alert">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1 text-sm text-[color:var(--text-primary)]">
        <p>
          <span className="font-medium">Votre dernier paiement a échoué.</span>{' '}
          <span className="text-[color:var(--text-muted)]">
            L&apos;ajout et la modification sont suspendus.
          </span>
        </p>
        <p className="text-[color:var(--text-muted)]">
          Vous pouvez toujours consulter vos biens et documents, les exporter et les transmettre.
          {echeance ? (
            <>
              {' '}Régularisez avant <span className="font-medium text-[color:var(--text-primary)]">{echeance}</span>{' '}
              pour retrouver l&apos;usage normal ; sans régularisation, vos données seront supprimées à cette date.
            </>
          ) : (
            <> Régularisez votre paiement pour retrouver l&apos;usage normal.</>
          )}
        </p>
      </div>
      <Button size="sm" onClick={regulariser} disabled={loading}>
        <CreditCard className="mr-1.5 h-4 w-4" />
        {UPDATE_PAYMENT_METHOD_LABEL}
      </Button>
    </div>
  );
}
