'use client';

/**
 * Lot 108L — état explicite « CGUV non vérifiées sur le site public ».
 *
 * Affiché à l'inscription (classique, Google / Apple) UNIQUEMENT quand la
 * version présentée n'est pas consultable sur le site public de
 * l'environnement : aucune acceptation n'est alors possible (le serveur la
 * refuse aussi, `CGUV_PUBLIC_TEXT_UNAVAILABLE`, Supervision ouverte), et
 * AUCUN lien de substitution n'est proposé (ni l'application, ni une autre
 * version).
 *
 * Lot 111O : le texte ne prétend plus connaître la cause (« en cours de
 * publication » était faux quand la cause est technique : configuration,
 * manifeste refusé, réseau…) ; la cause précise est donnée à l'exploitation
 * (BO › Exploitation › Santé › « CGUV publiées »). La page se réévalue seule ;
 * un bouton « Réessayer » relance la vérification. Le code de la version
 * bloquée n'est plus affiché : il ne peut pas être accepté.
 */
import { Loader2, RefreshCw } from 'lucide-react';

export const CGUV_PUBLIC_TEXT_NOTICE =
  'La création de compte est momentanément suspendue : les CGUV en vigueur n’ont pas encore pu être vérifiées sur le site Verebona. Cette page se met à jour automatiquement dès que c’est le cas.';

export function CguvPublicTextNotice({ onRetry, checking = false }: { versionCode?: string | null; onRetry?: () => void; checking?: boolean }) {
  return (
    <div role="status" aria-live="polite" data-testid="cguv-public-text-unavailable" className="text-sm rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3 text-[color:var(--text-muted)] space-y-2">
      <p>{CGUV_PUBLIC_TEXT_NOTICE}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={checking}
          data-testid="cguv-public-text-retry"
          className="inline-flex items-center gap-1.5 min-h-9 text-sm font-medium text-primary hover:underline disabled:opacity-60"
        >
          {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
          {checking ? 'Vérification…' : 'Réessayer'}
        </button>
      )}
    </div>
  );
}

/** Pur : la version reçue de `/api/legal/cguv/current` peut-elle être acceptée ? */
export function cguvAcceptable(data: { publicText?: unknown; permalinkUrl?: unknown } | null | undefined): boolean {
  if (!data) return true; // non chargée : le serveur tranche (fail-closed côté serveur)
  if (data.publicText === 'NOT_ON_PUBLIC_SITE') return false;
  return typeof data.permalinkUrl === 'string' && /^https?:\/\//.test(data.permalinkUrl);
}
