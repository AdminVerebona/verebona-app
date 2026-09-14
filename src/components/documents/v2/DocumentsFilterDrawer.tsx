'use client';

/**
 * Drawer « Tri & filtres » V2 — CDC V2.0 §4.2, §4.6, UX-01.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * IL N'Y A PAS DE CHAMP DE RECHERCHE, ET C'EST UNE EXIGENCE
 *
 * §4.2 : « Aucun champ de recherche local. La recherche reste centralisée au
 * niveau général de Verebona. » Le critère UX-01 le redit : « Aucun champ de
 * recherche local n'est ajouté. »
 *
 * C'est le point qui a le plus de chances d'être « corrigé » de bonne foi par
 * quelqu'un qui trouvera la page incomplète. La page V1 en avait un ; son
 * absence ici n'est pas un oubli.
 *
 * ── NI TRI NI FILTRES NE SONT MÉMORISÉS ───────────────────────────────────
 *
 * Aucun stockage n'est écrit — ni `localStorage`, ni cookie, ni préférence
 * serveur. Un utilisateur qui revient sur ses documents doit les voir tous,
 * pas hériter d'un filtre posé la semaine précédente et oublié depuis.
 *
 * ── PAS DE FILTRE PAR RUBRIQUE ────────────────────────────────────────────
 *
 * Il ne pourrait rien faire d'autre que masquer la structure permanente que le
 * §3.3 impose de garder visible. Les accordéons remplissent déjà ce besoin :
 * replier ce qu'on ne veut pas voir.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { SlidersHorizontal } from 'lucide-react';

export interface DocumentsV2Filters {
  sort: 'uploadedAt' | 'documentDate' | 'title';
  direction: 'asc' | 'desc';
  /** §4.6 — sur « Mes documents », le filtre Bien accepte une sélection multiple. */
  assetIds: number[];
  typeCodes: string[];
}

export const DEFAULT_V2_FILTERS: DocumentsV2Filters = {
  sort: 'uploadedAt',
  direction: 'desc',
  assetIds: [],
  typeCodes: [],
};

const SORTS: Array<{ code: DocumentsV2Filters['sort']; label: string }> = [
  { code: 'uploadedAt', label: "Date d'ajout" },
  { code: 'documentDate', label: 'Date du document' },
  { code: 'title', label: 'Titre' },
];

export function activeFilterCount(filters: DocumentsV2Filters): number {
  return (
    filters.assetIds.length +
    filters.typeCodes.length +
    (filters.sort === DEFAULT_V2_FILTERS.sort && filters.direction === DEFAULT_V2_FILTERS.direction
      ? 0
      : 1)
  );
}

export function DocumentsFilterDrawer({
  filters,
  onApply,
  assetOptions,
  typeOptions,
  /** Masque le filtre Bien dans l'onglet d'un bien : le contexte est explicite. */
  hideAssetFilter = false,
}: {
  filters: DocumentsV2Filters;
  onApply: (filters: DocumentsV2Filters) => void;
  assetOptions: Array<{ id: number; name: string }>;
  typeOptions: Array<{ code: string; label: string }>;
  hideAssetFilter?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DocumentsV2Filters>(filters);

  // Le brouillon repart de l'état appliqué à chaque ouverture : un filtre
  // sélectionné puis abandonné ne doit pas réapparaître coché.
  useEffect(() => {
    if (open) setDraft(filters);
  }, [open, filters]);

  const toggle = <T extends number | string>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const count = activeFilterCount(filters);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="h-9">
        <SlidersHorizontal className="mr-1.5 h-4 w-4" aria-hidden />
        Tri &amp; filtres
        {count > 0 && (
          <Badge variant="secondary" className="ml-1.5">
            {count}
          </Badge>
        )}
      </Button>

      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Tri &amp; filtres</DrawerTitle>
          </DrawerHeader>

          <div className="max-h-[60vh] space-y-6 overflow-y-auto px-4 pb-2">
            <div className="space-y-2">
              <Label>Trier par</Label>
              <div className="flex flex-wrap gap-2">
                {SORTS.map((sort) => (
                  <Button
                    key={sort.code}
                    size="sm"
                    variant={draft.sort === sort.code ? 'default' : 'outline'}
                    aria-pressed={draft.sort === sort.code}
                    onClick={() => setDraft((d) => ({ ...d, sort: sort.code }))}
                  >
                    {sort.label}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      direction: d.direction === 'desc' ? 'asc' : 'desc',
                    }))
                  }
                >
                  {draft.direction === 'desc' ? 'Décroissant' : 'Croissant'}
                </Button>
              </div>
            </div>

            {!hideAssetFilter && assetOptions.length > 0 && (
              <div className="space-y-2">
                <Label>Bien</Label>
                <div className="flex flex-wrap gap-2">
                  {assetOptions.map((asset) => (
                    <Button
                      key={asset.id}
                      size="sm"
                      variant={draft.assetIds.includes(asset.id) ? 'default' : 'outline'}
                      aria-pressed={draft.assetIds.includes(asset.id)}
                      onClick={() =>
                        setDraft((d) => ({ ...d, assetIds: toggle(d.assetIds, asset.id) }))
                      }
                    >
                      {asset.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label>Type</Label>
              {typeOptions.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Aucun type à filtrer pour le moment.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {typeOptions.map((type) => (
                    <Button
                      key={type.code}
                      size="sm"
                      variant={draft.typeCodes.includes(type.code) ? 'default' : 'outline'}
                      aria-pressed={draft.typeCodes.includes(type.code)}
                      onClick={() =>
                        setDraft((d) => ({ ...d, typeCodes: toggle(d.typeCodes, type.code) }))
                      }
                    >
                      {type.label}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <DrawerFooter>
            <Button
              onClick={() => {
                onApply(draft);
                setOpen(false);
              }}
            >
              Appliquer
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                onApply(DEFAULT_V2_FILTERS);
                setOpen(false);
              }}
            >
              Tout effacer
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </>
  );
}
