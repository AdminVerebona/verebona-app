'use client';

/**
 * Drawer « Tri & filtres » — CDC 5 design §7.1 et §7.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NI TRI NI FILTRES NE SONT MÉMORISÉS
 *
 * Le §7.1 et le §7.2 le disent chacun de leur côté : « le choix de tri n'est
 * pas mémorisé d'une visite à l'autre », « les filtres ne sont pas mémorisés
 * entre deux visites ».
 *
 * Aucun stockage n'est donc écrit — ni `localStorage`, ni cookie, ni
 * préférence serveur. Un utilisateur qui revient sur ses documents doit les
 * voir tous, pas hériter d'un filtre posé la semaine précédente et oublié
 * depuis.
 *
 * ── LE FILTRE PAR CATÉGORIE EST VOLONTAIREMENT ABSENT ─────────────────────
 *
 * Le §7.2 le laisse à l'appréciation du designer, sous une réserve : « il ne
 * doit jamais faire disparaître la structure permanente des catégories ».
 * Or un filtre par catégorie ne peut rien faire d'autre que cela — et le
 * critère D-03 impose que toutes restent visibles. Les accordéons remplissent
 * déjà ce besoin : replier ce qu'on ne veut pas voir.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { SlidersHorizontal, X } from 'lucide-react';
import { DEFAULT_FILTERS, type DocumentFilters } from './useDocumentBrowser';

const FORMATS: Array<{ code: string; label: string }> = [
  { code: 'pdf', label: 'PDF' },
  { code: 'image', label: 'Image' },
  { code: 'word', label: 'Document texte' },
  { code: 'excel', label: 'Tableur' },
  { code: 'web', label: 'Lien web' },
  { code: 'autre', label: 'Autre format' },
];

const SORTS: Array<{ code: DocumentFilters['sort']; label: string }> = [
  { code: 'createdAt', label: "Date d'ajout" },
  { code: 'documentDate', label: 'Date du document' },
  { code: 'title', label: 'Titre' },
];

export interface TypeOption {
  code: string;
  label: string;
}

export function SortFilterDrawer({
  open,
  onClose,
  filters,
  onApply,
  availableTypes,
}: {
  open: boolean;
  onClose: () => void;
  filters: DocumentFilters;
  onApply: (filters: DocumentFilters) => void;
  /** §7.2 : « ne propose que les types pertinents dans le contexte courant ». */
  availableTypes: TypeOption[];
}) {
  // Brouillon local : les filtres ne s'appliquent qu'à la validation, pour
  // éviter un rechargement à chaque case cochée.
  const [draft, setDraft] = useState<DocumentFilters>(filters);

  useEffect(() => { if (open) setDraft(filters); }, [open, filters]);

  if (!open) return null;

  const toggle = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true"
         aria-label="Tri et filtres">
      <button
        type="button"
        aria-label="Fermer"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />

      <div className="relative w-full max-w-sm h-full overflow-y-auto
                      bg-[color:var(--bg-card)] border-l border-[color:var(--border-subtle)]
                      p-5 space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Tri &amp; filtres</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Fermer">
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* ── Tri (§7.1) ────────────────────────────────────────────────── */}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium mb-1">Trier par</legend>
          {SORTS.map((option) => (
            <label key={option.code} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="sort"
                checked={draft.sort === option.code}
                onChange={() => setDraft({ ...draft, sort: option.code })}
              />
              {option.label}
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm pt-1">
            <input
              type="checkbox"
              checked={draft.direction === 'asc'}
              onChange={(e) => setDraft({ ...draft, direction: e.target.checked ? 'asc' : 'desc' })}
            />
            Ordre croissant
          </label>
        </fieldset>

        {/* ── À classer ─────────────────────────────────────────────────── */}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium mb-1">Classement</legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={draft.onlyToClassify}
              onChange={(e) => setDraft({ ...draft, onlyToClassify: e.target.checked })}
            />
            <span>
              Uniquement les documents à classer
              <span className="block text-xs text-[color:var(--text-muted)]">
                Ceux dont la catégorie ou le type reste à confirmer.
              </span>
            </span>
          </label>
        </fieldset>

        {/* ── Type documentaire (§7.2) ──────────────────────────────────── */}
        {availableTypes.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium mb-1">Type de document</legend>
            <div className="flex flex-wrap gap-1.5">
              {availableTypes.map((type) => {
                const active = draft.typeCodes.includes(type.code);
                return (
                  <button
                    key={type.code}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setDraft({ ...draft, typeCodes: toggle(draft.typeCodes, type.code) })}
                    className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-full"
                  >
                    <Badge
                      variant="outline"
                      className={active ? 'bg-primary/15 border-primary/40 text-primary' : ''}
                    >
                      {type.label}
                    </Badge>
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}

        {/* ── Format ────────────────────────────────────────────────────── */}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium mb-1">Format</legend>
          <div className="flex flex-wrap gap-1.5">
            {FORMATS.map((format) => {
              const active = draft.formats.includes(format.code);
              return (
                <button
                  key={format.code}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setDraft({ ...draft, formats: toggle(draft.formats, format.code) })}
                  className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-full"
                >
                  <Badge
                    variant="outline"
                    className={active ? 'bg-primary/15 border-primary/40 text-primary' : ''}
                  >
                    {format.label}
                  </Badge>
                </button>
              );
            })}
          </div>
        </fieldset>

        {/* ── Période ───────────────────────────────────────────────────── */}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium mb-1">Date du document</legend>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="dateFrom" className="text-xs">Du</Label>
              <Input
                id="dateFrom" type="date" value={draft.dateFrom ?? ''}
                onChange={(e) => setDraft({ ...draft, dateFrom: e.target.value || null })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dateTo" className="text-xs">Au</Label>
              <Input
                id="dateTo" type="date" value={draft.dateTo ?? ''}
                onChange={(e) => setDraft({ ...draft, dateTo: e.target.value || null })}
              />
            </div>
          </div>
        </fieldset>

        <div className="flex gap-2 pt-2 sticky bottom-0 bg-[color:var(--bg-card)] pb-1">
          <Button
            className="flex-1"
            onClick={() => { onApply(draft); onClose(); }}
          >
            Appliquer
          </Button>
          <Button
            variant="outline"
            onClick={() => setDraft({ ...DEFAULT_FILTERS })}
          >
            Réinitialiser
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Bouton d'ouverture, avec le nombre de filtres actifs. */
export function SortFilterButton({
  onClick,
  activeCount,
}: {
  onClick: () => void;
  activeCount: number;
}) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <SlidersHorizontal className="w-4 h-4 mr-1.5" aria-hidden />
      Tri &amp; filtres
      {activeCount > 0 && (
        <Badge variant="outline" className="ml-2 bg-primary/15 border-primary/40 text-primary">
          {activeCount}
        </Badge>
      )}
    </Button>
  );
}
