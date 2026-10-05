"use client";

/**
 * Formulaires d'ajout (document, bien, échéance) chargés à l'usage — APP-PERF-05.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE
 *
 * Le panneau « Ajouter » (`MobileActionsSheet`) importait directement
 * `UnifiedDocumentDialog`, `AssetFormDialog` et `CreateAgendaItemDrawer`. Le
 * panneau étant monté par la coquille (menu latéral et barre basse), ces trois
 * formulaires partaient dans le JavaScript initial de TOUTES les pages
 * authentifiées (relevé du build de production : présents dans les chunks
 * initiaux de /accueil), alors qu'ils ne servent qu'après un choix explicite.
 *
 * Chaque formulaire a désormais son chunk. Le chargement est :
 *   · déclenché à l'ouverture (montage conditionnel) ;
 *   · anticipé sur INTENTION seulement : survol, focus clavier ou toucher du
 *     bouton correspondant du panneau, et — pour le document — dès le clic,
 *     pendant que l'utilisateur choisit son fichier dans le sélecteur ;
 *   · partagé : préchargement et rendu attendent la MÊME promesse, le chunk
 *     n'est jamais demandé deux fois.
 * Un échec de préchargement est silencieux et oublié : l'ouverture réelle
 * retente, et une erreur de chunk passe alors par la reprise PWA bornée
 * (`lib/pwa/chunk-recovery`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';

export type AddFormKind = 'file' | 'asset' | 'agenda';

/** Promesse d'import mémorisée ; oubliée en cas d'échec pour permettre une reprise. */
function memoImport<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = load().catch((error) => {
        pending = null;
        throw error;
      });
    }
    return pending;
  };
}

export const loadDocumentDialog = memoImport(() => import('@/components/documents/unified-document-dialog'));
export const loadAssetFormDialog = memoImport(() => import('@/components/AssetFormDialog'));
export const loadAgendaDrawer = memoImport(() => import('@/components/agenda/CreateAgendaItemDrawer'));

const LOADERS: Record<AddFormKind, () => Promise<unknown>> = {
  file: loadDocumentDialog,
  asset: loadAssetFormDialog,
  agenda: loadAgendaDrawer,
};

/** Anticipe le chargement d'un formulaire sur intention (survol, focus, toucher). */
export function preloadAddForm(kind: AddFormKind): void {
  void LOADERS[kind]().catch(() => undefined);
}

/**
 * État de chargement local et accessible, affiché le temps du premier
 * chargement d'un formulaire (chunk froid). Il n'est jamais vu à chaud.
 */
export function AddFormLoading() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-3 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-5 py-4 text-sm text-[color:var(--text-primary)] shadow-xl"
      >
        <Loader2 className="h-4 w-4 animate-spin text-[color:var(--accent)]" aria-hidden />
        Ouverture du formulaire…
      </div>
    </div>
  );
}

export const LazyUnifiedDocumentDialog = dynamic(
  () => loadDocumentDialog().then((m) => ({ default: m.UnifiedDocumentDialog })),
  { ssr: false, loading: () => <AddFormLoading /> },
);

export const LazyAssetFormDialog = dynamic(
  () => loadAssetFormDialog().then((m) => ({ default: m.AssetFormDialog })),
  { ssr: false, loading: () => <AddFormLoading /> },
);

export const LazyCreateAgendaItemDrawer = dynamic(
  () => loadAgendaDrawer().then((m) => ({ default: m.CreateAgendaItemDrawer })),
  { ssr: false, loading: () => <AddFormLoading /> },
);
