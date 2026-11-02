'use client';

/**
 * Lot 102A — bandeau SOBRE d'un compte en état restreint (fin d'essai, fin
 * d'abonnement, rétractation) : « Lecture seule jusqu'au … », accès direct à
 * l'export de ses données et à la souscription (qui annule la suppression).
 *
 * Toutes les valeurs viennent du serveur (`/api/billing/trial-status`,
 * `restrictedState`) : date de suppression RÉELLEMENT programmée, jamais
 * recalculée ici. Desktop et mobile (les boutons passent à la ligne).
 * Application mobile native : aucun bouton de souscription (lot 97B).
 */
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NativeCommerceNotice } from '@/components/native/NativeCommerceNotice';
import {
  RESTRICTED_REASON_BANNER,
  formatParisLongDate,
} from '@/lib/account-lifecycle/retention-policy';
import type { TrialStatusPayload } from '@/lib/trial-status';

type State = NonNullable<TrialStatusPayload['restrictedState']>;

/** Texte du bandeau (pur, testé) : phrase de contexte + date de lecture seule. */
export function restrictedStateTexts(state: State): { title: string; detail: string } {
  const until = formatParisLongDate(state.purgeAt);
  const context = state.reason === 'SUPPRESSION_DEMANDEE' ? '' : RESTRICTED_REASON_BANNER[state.reason];
  return {
    title: `Votre compte est en lecture seule jusqu’au ${until}.`,
    detail: [
      context,
      'Vos biens et documents restent consultables et exportables.',
      state.cancelledBySubscription ? 'Après cette date, ils seront supprimés, sauf souscription d’ici là.' : '',
    ].filter(Boolean).join(' '),
  };
}

export function RestrictedStateNotice({ state, commerceHidden }: { state: State; commerceHidden: boolean }) {
  const { title, detail } = restrictedStateTexts(state);
  return (
    <div
      role="status"
      data-testid="restricted-state-notice"
      className="flex flex-wrap items-center gap-3 border-b border-[color:var(--border)] bg-[color:var(--bg-subtle)] px-4 py-3"
    >
      <Lock className="h-4 w-4 shrink-0 text-[color:var(--text-muted)]" aria-hidden />
      <p className="min-w-[14rem] flex-1 text-sm text-[color:var(--text-primary)]">
        <span className="font-medium">{title}</span>{' '}
        <span className="text-[color:var(--text-muted)]">{detail}</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" asChild>
          <Link href="/mon-compte#mes-donnees">Exporter mes données</Link>
        </Button>
        {commerceHidden ? (
          <NativeCommerceNotice className="text-xs text-[color:var(--text-muted)]" />
        ) : (
          <Button size="sm" asChild>
            <Link href="/mon-compte/offres">Choisir une offre</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
