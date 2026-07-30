'use client';

/**
 * Vue documentaire commune — CDC 5 design §3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * C'EST ICI QUE LES DEUX ÉCRANS DEVIENNENT UN SEUL
 *
 * Le §1.3 du CDC fonctionnel reproche à l'existant que « la page globale et
 * l'onglet d'un bien possèdent des implémentations distinctes ». Le principe 6
 * du §2 en tire la conséquence : « employer les mêmes composants et
 * comportements sur les deux écrans afin d'éviter les divergences futures ».
 *
 * Cette vue est donc la seule. « Mes documents » l'appelle sans `assetId`,
 * l'onglet d'un bien avec. Les trois différences du §3 en découlent
 * automatiquement :
 *
 *   · catégories pertinentes — le serveur les restreint au type du bien ;
 *   · bien courant masqué sur chaque ligne — `hideAssetId` ;
 *   · « À classer » limité au bien — le filtre serveur s'applique à tous les
 *     groupes, celui-là compris.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useMemo, useState } from 'react';
import { CategoryAccordion, CategorySkeleton } from './CategoryAccordion';
import { EmptyDocuments } from './DocumentCard';
import { SortFilterDrawer, SortFilterButton, type TypeOption } from './SortFilterDrawer';
import { useDocumentBrowser } from './useDocumentBrowser';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function DocumentsView({
  title,
  assetId,
  availableTypes,
  headerActions,
  onOpenDocument,
}: {
  title: string;
  /** Renseigné = onglet d'un bien ; absent = page globale. */
  assetId?: number;
  availableTypes: TypeOption[];
  headerActions?: React.ReactNode;
  onOpenDocument: (id: number) => void;
}) {
  const browser = useDocumentBrowser({ assetId });
  const [filtersOpen, setFiltersOpen] = useState(false);

  const filtered = browser.activeFilterCount > 0;

  // §7.3 : « toutes les catégories restent visibles lorsque leur compteur
  // filtré vaut 0 ». Aucune n'est retirée de la liste, même vide.
  const hasAnyDocument = useMemo(
    () => browser.groups.some((g) => g.count > 0),
    [browser.groups],
  );

  return (
    <div className="space-y-4">
      {/* ── Niveau 1 : titre et compteur global (§3.1) ────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{title}</h1>
        <span
          className="text-sm text-[color:var(--text-muted)] tabular-nums"
          aria-live="polite"
        >
          {browser.totalCount} document{browser.totalCount > 1 ? 's' : ''}
          {browser.toClassifyCount > 0 && (
            <> · {browser.toClassifyCount} à classer</>
          )}
        </span>

        {/* ── Niveau 2 : actions (§3.1) ───────────────────────────────── */}
        <div className="ml-auto flex items-center gap-2">
          <SortFilterButton
            onClick={() => setFiltersOpen(true)}
            activeCount={browser.activeFilterCount}
          />
          {headerActions}
        </div>
      </div>

      {/* D-01 : aucun champ de recherche local sur ces écrans. La recherche
          globale existante reste le point d'entrée. */}

      {browser.error && (
        <div className="rounded-md bg-destructive/10 text-destructive text-sm p-3
                        flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
          <span className="flex-1">{browser.error}</span>
          <Button variant="outline" size="sm" onClick={browser.reload}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" aria-hidden />
            Réessayer
          </Button>
        </div>
      )}

      {/* ── Niveaux 3 et 4 : catégories et documents ──────────────────── */}
      {browser.loading ? (
        <div className="space-y-3">
          <CategorySkeleton />
          <CategorySkeleton />
          <CategorySkeleton />
        </div>
      ) : !hasAnyDocument ? (
        <EmptyDocuments filtered={filtered} />
      ) : (
        <div className="space-y-3">
          {browser.groups.map((group) => (
            <CategoryAccordion
              key={group.code}
              group={group}
              onOpenDocument={onOpenDocument}
              onLoadMore={browser.loadMore}
              loadingMore={browser.loadingGroup === group.code}
              hideAssetId={assetId}
            />
          ))}
        </div>
      )}

      <SortFilterDrawer
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        filters={browser.filters}
        onApply={browser.setFilters}
        availableTypes={availableTypes}
      />
    </div>
  );
}

/**
 * Exposé pour que la page hôte applique les deltas après une modification
 * dans le drawer, sans recharger (§5.1, §8.4).
 */
export { useDocumentBrowser } from './useDocumentBrowser';
export type { DocumentFilters } from './useDocumentBrowser';
