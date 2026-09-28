'use client';

/**
 * Filtres de « Mes documents » et de l'onglet Documents d'un bien.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN PANNEAU DANS LA PAGE, PLUS UN TIROIR
 *
 * Maquette « Mes documents », direction 1a : le bouton « Filtres » déplie un
 * panneau sous la barre d'outils — Bien, Rubrique, Type — et les filtres
 * actifs restent visibles en permanence sous forme de pastilles « Filtré
 * par … », chacune retirable, avec « Tout effacer ». On voit ce qui masque
 * des documents sans rouvrir quoi que ce soit.
 *
 * Le tri n'est plus ici : il est global et a sa place dans la barre d'outils.
 *
 * ── TOUJOURS SANS CHAMP DE RECHERCHE ──────────────────────────────────────
 *
 * §4.2 et UX-01 : « Aucun champ de recherche local. » La recherche reste
 * centralisée au niveau général de Verebona.
 *
 * ── LE FILTRE RUBRIQUE EST ARRIVÉ AVEC LE REGROUPEMENT OPTIONNEL ──────────
 *
 * Tant que les Rubriques étaient des boîtes permanentes, un filtre Rubrique
 * n'aurait fait que masquer la structure. Maintenant que le regroupement se
 * désactive, c'est le seul moyen de restreindre une liste à plat à une
 * Rubrique : la maquette le prévoit, « Sans rubrique » compris.
 *
 * ── LES FILTRES NE SONT PAS MÉMORISÉS ─────────────────────────────────────
 *
 * Voir `view-prefs.ts` : seules les manières de regarder le sont.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { X } from 'lucide-react';
import type { DocumentsContext, FilterOption, ViewFilters } from './documents-view';

/** Pastille de filtre — FilterPill du design system. */
function FilterPill({ option, onClick }: { option: FilterOption; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={option.active}
      className={`max-w-full truncate whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        option.active
          ? 'border-[rgba(59,130,246,.3)] bg-[rgba(59,130,246,.2)] text-[color:var(--text-info-soft)]'
          : 'border-border text-[color:var(--text-muted)] hover:bg-[color:var(--accent-soft)] hover:text-[color:var(--text-primary)]'
      }`}
    >
      {option.label} · {option.count}
    </button>
  );
}

function Section({
  id,
  title,
  options,
  onToggle,
}: {
  id: string;
  title: string;
  options: FilterOption[];
  onToggle: (value: string) => void;
}) {
  return (
    <div role="group" aria-labelledby={id} className="flex min-w-0 flex-col gap-2.5">
      <p id={id} className="text-[11px] font-semibold uppercase tracking-[.05em] text-[color:var(--text-muted)]">
        {title}
      </p>
      {options.length === 0 ? (
        <p className="text-xs text-[color:var(--text-muted)]">Rien à filtrer ici pour le moment.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => (
            <FilterPill key={o.value} option={o} onClick={() => onToggle(o.value)} />
          ))}
        </div>
      )}
    </div>
  );
}

export function DocumentsFilterPanel({
  id,
  context,
  options,
  onToggle,
}: {
  id: string;
  context: DocumentsContext;
  options: { biens: FilterOption[]; rubrics: FilterOption[]; types: FilterOption[] };
  onToggle: (dim: keyof ViewFilters, value: string) => void;
}) {
  // Dans l'onglet d'un bien, le périmètre est déjà le bien : pas de filtre Bien.
  const avecBien = context === 'mes-documents';
  return (
    <div
      id={id}
      className={`mb-[22px] -mt-1.5 grid grid-cols-1 gap-[22px] rounded-xl border border-border bg-[color:var(--bg-card)] px-[18px] py-4 ${
        avecBien ? 'md:grid-cols-[.8fr_1fr_1.4fr]' : 'md:grid-cols-[1fr_1.4fr]'
      }`}
    >
      {avecBien && (
        <Section id={`${id}-bien`} title="Bien" options={options.biens} onToggle={(v) => onToggle('biens', v)} />
      )}
      <Section id={`${id}-rubrique`} title="Rubrique" options={options.rubrics} onToggle={(v) => onToggle('rubrics', v)} />
      <Section id={`${id}-type`} title="Type" options={options.types} onToggle={(v) => onToggle('types', v)} />
    </div>
  );
}

/** Ligne « Filtré par … » : un filtre actif = une pastille retirable. */
export function ActiveFilterChips({
  chips,
  onRemove,
  onClear,
}: {
  chips: Array<{ dim: keyof ViewFilters; value: string; label: string }>;
  onRemove: (dim: keyof ViewFilters, value: string) => void;
  onClear: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="-mt-2 mb-5 flex flex-wrap items-center gap-1.5 text-xs text-[color:var(--text-muted)]">
      <span className="mr-1">Filtré par</span>
      {chips.map((c) => (
        <button
          key={`${c.dim}:${c.value}`}
          type="button"
          onClick={() => onRemove(c.dim, c.value)}
          aria-label={`Retirer le filtre ${c.label}`}
          className="flex items-center gap-[5px] rounded-full bg-[color:var(--accent-soft)] py-[3px] pl-2.5 pr-1.5 font-medium text-[color:var(--text-info)] transition-colors hover:bg-[rgba(59,130,246,.2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {c.label}
          <X className="h-3 w-3" aria-hidden />
        </button>
      ))}
      <button
        type="button"
        onClick={onClear}
        className="ml-1.5 underline transition-colors hover:text-[color:var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
      >
        Tout effacer
      </button>
    </div>
  );
}
