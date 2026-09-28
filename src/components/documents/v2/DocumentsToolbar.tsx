'use client';

/**
 * Barre d'outils des documents — maquette « Mes documents », direction 1a.
 *
 * De gauche à droite : décompte, « Par rubrique », Liste / Vignettes, tri
 * global et son sens, « Filtres », « Ajouter un document ». Une seule ligne
 * sur ordinateur ; sur téléphone, le décompte prend la première ligne et les
 * commandes passent à la ligne suivante.
 *
 * Chaque bascule annonce son état : `aria-pressed` pour Liste / Vignettes,
 * `role="switch"` pour le regroupement, `aria-expanded` pour le panneau de
 * filtres.
 */
import { ChevronDown, Plus, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { SortDir, SortKey, ViewMode } from './documents-view';

/** Contrôle segmenté du design system (pilule, segment actif en bleu plein). */
function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex shrink-0 gap-1 rounded-full border border-[rgba(148,163,184,.25)] bg-[rgba(15,23,42,.5)] p-[3px] [.theme-beige_&]:bg-black/[.03]"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={`h-[24px] rounded-full px-3.5 text-[13px] font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              on ? 'bg-primary text-white' : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function DocumentsToolbar({
  countLabel,
  grouped,
  onGroupedChange,
  view,
  onViewChange,
  sort,
  sortOptions,
  onSortChange,
  dir,
  onDirToggle,
  filterCount,
  filtersOpen,
  filtersPanelId,
  onFiltersToggle,
  onAdd,
}: {
  countLabel: string;
  grouped: boolean;
  onGroupedChange: (v: boolean) => void;
  view: ViewMode;
  onViewChange: (v: ViewMode) => void;
  sort: SortKey;
  sortOptions: ReadonlyArray<{ value: SortKey; label: string }>;
  onSortChange: (v: SortKey) => void;
  dir: SortDir;
  onDirToggle: () => void;
  filterCount: number;
  filtersOpen: boolean;
  filtersPanelId: string;
  onFiltersToggle: () => void;
  onAdd: () => void;
}) {
  const sensLabel = dir === 'desc' ? 'Ordre décroissant' : 'Ordre croissant';
  return (
    <div
      role="toolbar"
      aria-label="Affichage des documents"
      className="mb-[22px] flex flex-wrap items-center gap-x-3.5 gap-y-2.5 border-b border-[color:var(--border-subtle)] pb-3.5 pt-2.5"
    >
      <p className="w-full text-[13px] text-[color:var(--text-muted)] sm:mr-auto sm:w-auto" aria-live="polite">
        {countLabel}
      </p>

      <label className="flex cursor-pointer items-center gap-2.5 text-[13px] font-medium sm:mr-1.5">
        <Switch checked={grouped} onCheckedChange={onGroupedChange} />
        Par rubrique
      </label>

      <SegmentedControl
        label="Mode d'affichage"
        options={[{ value: 'list', label: 'Liste' }, { value: 'grid', label: 'Vignettes' }] as const}
        value={view}
        onChange={onViewChange}
      />

      <div className="flex items-center gap-1.5">
        <div className="relative">
          <select
            aria-label="Trier par"
            value={sort}
            onChange={(e) => onSortChange(e.target.value as SortKey)}
            className="h-8 w-[140px] cursor-pointer sm:w-[170px] appearance-none rounded-lg border border-border bg-[rgba(30,41,59,.6)] pl-3 pr-8 text-sm text-[color:var(--text-primary)] outline-none transition-all focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 [.theme-beige_&]:bg-[#F9FAFB]"
          >
            {sortOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--text-muted)]" aria-hidden />
        </div>
        <button
          type="button"
          onClick={onDirToggle}
          aria-label={`${sensLabel} — inverser`}
          title={sensLabel}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-[color:var(--text-muted)] transition-all hover:bg-[color:var(--accent-soft)] hover:text-[color:var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform duration-200 ${dir === 'desc' ? '' : 'rotate-180'}`}
            aria-hidden
          />
        </button>
      </div>

      <Button
        size="sm"
        variant={filterCount > 0 ? 'secondary' : 'outline'}
        onClick={onFiltersToggle}
        aria-expanded={filtersOpen}
        aria-controls={filtersPanelId}
        className={`btn-filter ${filterCount > 0 ? 'bg-[color:var(--accent-soft)]' : ''}`}
      >
        <SlidersHorizontal className="btn-filter-sliders-icon h-4 w-4" aria-hidden />
        {filterCount > 0 ? `Filtres · ${filterCount}` : 'Filtres'}
      </Button>

      {/* Téléphone : icône seule (la barre mobile a aussi son « + »), nom accessible conservé. */}
      <Button size="sm" onClick={onAdd} className="btn-add" aria-label="Ajouter un document">
        <Plus className="btn-add-plus-icon h-4 w-4" aria-hidden />
        <span className="hidden sm:inline">Ajouter un document</span>
      </Button>
    </div>
  );
}
