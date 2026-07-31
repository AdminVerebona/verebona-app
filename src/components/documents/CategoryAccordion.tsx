'use client';

/**
 * Composant catégorie — CDC 5 design §3.1, §7.3, livrable §10.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS RÈGLES QUE CE COMPOSANT NE PEUT PAS ENFREINDRE
 *
 * · D-03 — « toutes les catégories pertinentes restent visibles, y compris
 *   à 0 ». Une catégorie vide n'est donc jamais masquée : elle est rendue
 *   inerte, ce qui la montre sans inviter à un clic qui ne mènerait nulle part.
 *
 * · D-04 — « À classer » toujours premier, « Autres documents » toujours
 *   dernier. L'ordre vient du serveur, ce composant ne trie rien.
 *
 * · §7.3 — le compteur porte sur l'ensemble filtré, pas sur ce qui est
 *   affiché. Il vient du serveur pour cette raison : le calculer à partir de
 *   `documents.length` le plafonnerait à la taille de l'aperçu.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Choix de conception retenus (§10.2) : accordéons, ouverts par défaut quand
 * la catégorie est remplie ; aperçu de six documents puis « Voir les N
 * autres » ; catégories à 0 inertes.
 */

import { useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { DocumentCard, EmptyCategory, type DocumentCardData } from './DocumentCard';

/** Aperçu avant repli (décision n°2). */
export const PREVIEW_SIZE = 6;

export interface CategoryGroupData {
  code: string;
  label: string;
  count: number;
  documents: DocumentCardData[];
  hasMore: boolean;
}

export function CategoryAccordion({
  group,
  onOpenDocument,
  onLoadMore,
  loadingMore,
  hideAssetId,
}: {
  group: CategoryGroupData;
  onOpenDocument: (document: DocumentCardData) => void;
  onLoadMore: (code: string) => void;
  loadingMore?: boolean;
  hideAssetId?: number;
}) {
  const empty = group.count === 0;
  // Ouverte par défaut si elle contient quelque chose : l'utilisateur vient
  // voir ses documents, pas déplier des titres.
  const [open, setOpen] = useState(!empty);
  const contentId = `cat-${group.code}`;

  return (
    <section
      className={`rounded-xl border border-[color:var(--border-subtle)] overflow-hidden ${
        empty ? 'opacity-60' : ''
      }`}
    >
      <h3>
        <button
          type="button"
          // Une catégorie vide est inerte : ouvrir un accordéon pour n'y rien
          // trouver est une frustration gratuite (décision n°3).
          disabled={empty}
          aria-expanded={empty ? undefined : open}
          aria-controls={empty ? undefined : contentId}
          onClick={() => !empty && setOpen((v) => !v)}
          className={`w-full flex items-center gap-2 px-4 py-3 text-left
                      bg-[color:var(--bg-card)]
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
                      ${empty ? 'cursor-default' : 'hover:bg-[color:var(--bg-page)]'}`}
        >
          {!empty && (
            <ChevronDown
              className={`w-4 h-4 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
              aria-hidden
            />
          )}
          {empty && <span className="w-4 shrink-0" aria-hidden />}

          <span className="flex-1 text-sm font-medium text-[color:var(--text-primary)]">
            {group.label}
          </span>

          {/* §7.3 : compteur toujours visible, y compris à 0. */}
          <span
            className="text-xs tabular-nums text-[color:var(--text-muted)]"
            aria-label={`${group.count} document${group.count > 1 ? 's' : ''}`}
          >
            {group.count}
          </span>
        </button>
      </h3>

      {!empty && open && (
        <div id={contentId} className="p-3 pt-0 space-y-2 bg-[color:var(--bg-card)]">
          {group.documents.length === 0 ? (
            <EmptyCategory label={group.label} />
          ) : (
            group.documents.map((doc) => (
              <DocumentCard
                key={doc.id}
                document={doc}
                onOpen={onOpenDocument}
                hideAssetId={hideAssetId}
              />
            ))
          )}

          {group.hasMore && (
            <button
              type="button"
              onClick={() => onLoadMore(group.code)}
              disabled={loadingMore}
              className="w-full py-2 text-sm text-primary hover:underline
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
                         rounded-md disabled:opacity-50"
            >
              {loadingMore ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                  Chargement…
                </span>
              ) : (
                `Voir les ${group.count - group.documents.length} autres`
              )}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** Squelette de chargement (§8, livrable §10.1). */
export function CategorySkeleton() {
  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] p-4 space-y-3">
      <div className="h-4 w-40 rounded bg-[color:var(--bg-page)] animate-pulse" />
      <div className="h-12 rounded-lg bg-[color:var(--bg-page)] animate-pulse" />
      <div className="h-12 rounded-lg bg-[color:var(--bg-page)] animate-pulse" />
    </div>
  );
}
