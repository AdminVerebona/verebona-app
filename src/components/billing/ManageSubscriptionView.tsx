'use client';

/**
 * « Gérer mon abonnement sur Stripe » — vue du lien PERMANENT des e-mails (lot
 * 68C, rappel J−7 avant renouvellement annuel), partagée par
 * `/mon-compte/abonnement/gerer` et (lot 72F) `/mon-compte/abonnement/gerer/<compte>`.
 *
 * Lot 72F : `accountRef` (référence durable du compte facturé, portée par le
 * lien) est transmise à la route : le serveur n'ouvre QUE le portail de ce
 * compte, après contrôle du titulaire — jamais de bascule silencieuse.
 *
 * À l'ouverture : session Stripe Customer Portal créée À CET INSTANT pour le
 * titulaire payeur (route existante, logique unique), puis redirection vers
 * Stripe. Connexion demandée si besoin (middleware / api-client, retour ici
 * ensuite). Application installée : repli visible si la coquille a confié
 * Stripe au navigateur du téléphone (voir `lib/billing/manage-subscription-redirect.ts`).
 * Même composant sur ordinateur et mobile (mise en page fluide).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Loader2, ExternalLink } from 'lucide-react';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import { PORTAL_FALLBACK_MS, goToPortal, portalErrorView, type PortalErrorView } from '@/lib/billing/manage-subscription-redirect';

type State =
  | { kind: 'loading' }
  | { kind: 'redirecting'; external: boolean }
  | { kind: 'fallback'; external: boolean }
  | { kind: 'error'; view: PortalErrorView };

export function ManageSubscriptionView({ accountRef }: { accountRef?: string | null }) {
  const { setBreadcrumbs } = useBreadcrumb();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const started = useRef(false);

  useEffect(() => {
    setBreadcrumbs([{ label: 'Mon compte', href: '/mon-compte' }, { label: 'Gérer mon abonnement' }]);
  }, [setBreadcrumbs]);

  const open = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await apiClient.post<{ portal_url?: string }>('/api/billing/create-customer-portal-session', accountRef ? { accountRef } : {});
      if (!res.portal_url) throw Object.assign(new Error('NO_URL'), { code: 'PORTAL_SESSION_FAILED' });
      const nav = goToPortal(res.portal_url, window as never);
      setState({ kind: 'redirecting', external: nav === 'external' });
      // Navigation interceptée (application installée) ou lente : repli visible.
      window.setTimeout(() => setState((s) => (s.kind === 'redirecting' ? { kind: 'fallback', external: s.external } : s)), PORTAL_FALLBACK_MS);
    } catch (e) {
      const err = e as { code?: string; serverMessage?: string; status?: number };
      // Session perdue : l'api-client renvoie déjà à la connexion (retour ici).
      if (err.status === 401) return;
      setState({ kind: 'error', view: portalErrorView(err.code, err.serverMessage) });
    }
  }, [accountRef]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void open();
  }, [open]);

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-8 sm:py-12" data-testid="manage-subscription-page">
      <div className="rounded-xl border bg-card p-5 sm:p-6 space-y-4">
        <h1 className="vb-app-section">Gérer mon abonnement</h1>

        {(state.kind === 'loading' || state.kind === 'redirecting') && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {state.kind === 'loading' ? 'Ouverture de votre espace de gestion Stripe…' : 'Redirection vers Stripe…'}
          </p>
        )}

        {state.kind === 'fallback' && (
          <div className="space-y-3" data-testid="manage-subscription-fallback">
            <p className="text-sm">
              {state.external
                ? 'Votre espace de gestion Stripe s’est ouvert dans le navigateur de votre téléphone.'
                : 'Si la page Stripe ne s’est pas affichée, ouvrez-la avec le bouton ci-dessous.'}
              {' '}Vous pouvez y désactiver le renouvellement automatique, consulter vos factures et vos moyens de paiement.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button onClick={() => void open()}>
                <ExternalLink className="h-4 w-4 mr-1.5" aria-hidden /> Rouvrir l’espace Stripe
              </Button>
              <Button asChild variant="outline"><Link href="/mon-compte">Retour à mon compte</Link></Button>
            </div>
          </div>
        )}

        {state.kind === 'error' && (
          <div className="space-y-3" data-testid="manage-subscription-error" role="alert">
            <p className="text-sm font-medium">{state.view.title}</p>
            <p className="text-sm text-muted-foreground">{state.view.message}</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              {state.view.retry ? <Button onClick={() => void open()}>Réessayer</Button> : null}
              <Button asChild variant="outline"><Link href="/mon-compte">Retour à mon compte</Link></Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
