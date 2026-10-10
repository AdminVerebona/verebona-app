'use client';

/**
 * Hôte des parcours de création — voir `src/lib/create-flows.ts` (lot 34G).
 *
 * Monté une fois dans DashboardLayout, à côté de GlobalDrawerHost. Il ouvre
 * directement le formulaire demandé — document, bien, échéance —, chargé à
 * l'usage (`mobile/add-forms`), avec le bien déjà résolu présélectionné.
 *
 * Droits et quotas : la garde d'écriture STANDARD de l'application
 * (`useWriteGuard`, la même que « + Ajouter ») est appliquée avant
 * l'ouverture — fin d'essai, abonnement requis, quota documents ou biens
 * atteint ouvrent la fenêtre de refus habituelle. Le serveur reste seul
 * juge de chaque écriture.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { OPEN_CREATE_FLOW, createFlowView, parseCreateFlowRequest, type CreateFlowRequest } from '@/lib/create-flows';
import {
  LazyAssetFormDialog, LazyCreateAgendaItemDrawer, LazyUnifiedDocumentDialog, preloadAddForm,
} from '@/components/mobile/add-forms';

/** Les écrans ouverts dessous se rafraîchissent sur les événements métier existants. */
function signalMutation(agenda = false) {
  if (agenda) window.dispatchEvent(new CustomEvent('agenda-mutated'));
  window.dispatchEvent(new CustomEvent('refresh-a-traiter'));
}

const PRECHARGEMENT = { document: 'file', asset: 'asset', agenda_item: 'agenda' } as const;

export function GlobalCreateFlowHost() {
  const { user } = useSession();
  const { garder } = useWriteGuard();
  const [ouvert, setOuvert] = useState<CreateFlowRequest | null>(null);

  const ouvrir = useCallback((r: CreateFlowRequest) => {
    preloadAddForm(PRECHARGEMENT[r.flow]);
    garder(() => setOuvert(r), createFlowView(r).quota);
  }, [garder]);

  useEffect(() => {
    const handler = (e: Event) => {
      const r = parseCreateFlowRequest((e as CustomEvent<CreateFlowRequest>).detail);
      if (r) ouvrir(r);
    };
    window.addEventListener(OPEN_CREATE_FLOW, handler);
    return () => window.removeEventListener(OPEN_CREATE_FLOW, handler);
  }, [ouvrir]);

  const fermer = () => setOuvert(null);
  if (!ouvert) return null;
  const vue = createFlowView(ouvert);
  const assetId = vue.preselectedAssetId ?? undefined;

  if (vue.component === 'UnifiedDocumentDialog') {
    return (
      <LazyUnifiedDocumentDialog
        open
        onOpenChange={(v) => { if (!v) fermer(); }}
        preselectedAssetId={assetId}
        onSuccess={() => { fermer(); signalMutation(); }}
      />
    );
  }
  if (vue.component === 'CreateAgendaItemDrawer') {
    return (
      <LazyCreateAgendaItemDrawer
        open
        onClose={fermer}
        onMutated={() => { fermer(); signalMutation(true); }}
        prefilledAssetId={assetId}
      />
    );
  }
  if (!user?.id) return null;
  return (
    <LazyAssetFormDialog
      open
      onOpenChange={(v) => { if (!v) fermer(); }}
      userId={user.id}
      onSuccess={() => { fermer(); signalMutation(); }}
    />
  );
}
