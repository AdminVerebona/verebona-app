'use client';

/**
 * Commandes de filtre partagées — « Mes documents » (référence) et « Mon
 * agenda ». Lot 71 (71C), ticket « Harmonisation des filtres Documents /
 * Agenda ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE LOGIQUE D'INTERACTION, DANS LA PAGE
 *
 *   · un bouton « Filtres » (« Filtres · N » quand des filtres agissent)
 *     déplie un PANNEAU intégré sous la barre d'outils — jamais un tiroir,
 *     ni sur ordinateur ni sur téléphone ;
 *   · le panneau aligne des SECTIONS titrées (petites capitales) de
 *     PASTILLES : choix multiples (`aria-pressed`) ou choix unique
 *     (`role="radio"`, flèches du clavier) ;
 *   · les filtres actifs restent visibles en permanence, panneau replié,
 *     sous forme de pastilles « Filtré par … » retirables, avec « Tout
 *     effacer ».
 *
 * Le panneau replié par défaut et les pastilles qui passent à la ligne
 * tiennent la hauteur sur téléphone ; une liste longue (équipements) se
 * replie au-delà de quelques options (« Afficher les N autres »).
 *
 * Les styles sont ceux, inchangés, du panneau de « Mes documents » (charte
 * « Sérénité », jetons existants).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface PillOption {
  value: string;
  label: string;
  /** Nom accessible quand le libellé visible ne suffit pas (bien d'un équipement). */
  ariaLabel?: string;
  /** Compteur affiché « Libellé · N » ; `null` / absent : pas de compteur. */
  count?: number | null;
  active: boolean;
}

const PILL_BASE = 'max-w-full truncate whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-[180ms]';
const PILL_ON = 'border-[color:var(--accent)] bg-[color:var(--accent-soft)] font-semibold text-[color:var(--text-primary)]';
const PILL_OFF = 'border-border text-[color:var(--text-muted)] hover:bg-[color:var(--accent-soft)] hover:text-[color:var(--text-primary)]';

function pillText(option: PillOption): string {
  return option.count === null || option.count === undefined ? option.label : `${option.label} · ${option.count}`;
}

/** Pastille de filtre à bascule (choix multiples) — FilterPill du design system. */
function FilterPill({ option, onClick }: { option: PillOption; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={option.active}
      aria-label={option.ariaLabel}
      className={`${PILL_BASE} ${option.active ? PILL_ON : PILL_OFF}`}
    >
      {pillText(option)}
    </button>
  );
}

/** Section titrée du panneau (groupe nommé par son titre). */
export function FilterSection({
  id,
  title,
  className = '',
  children,
}: {
  id: string;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-labelledby={id} className={`flex min-w-0 flex-col gap-2.5 ${className}`}>
      <p id={id} className="vb-app-label">
        {title}
      </p>
      {children}
    </div>
  );
}

/** Section à choix multiples (pastilles à bascule). */
export function FilterPillSection({
  id,
  title,
  options,
  onToggle,
  className,
  emptyText = 'Rien à filtrer ici pour le moment.',
}: {
  id: string;
  title: string;
  options: PillOption[];
  onToggle: (value: string) => void;
  className?: string;
  emptyText?: string;
}) {
  return (
    <FilterSection id={id} title={title} className={className}>
      {options.length === 0 ? (
        <p className="text-xs text-[color:var(--text-muted)]">{emptyText}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => (
            <FilterPill key={o.value} option={o} onClick={() => onToggle(o.value)} />
          ))}
        </div>
      )}
    </FilterSection>
  );
}

export interface ChoiceGroup {
  /** Clé stable du sous-groupe. */
  key: string;
  /** Titre de sous-groupe (bien d'un équipement) ; absent : pas de titre. */
  label?: string;
  /** Options repliables au-delà de `collapseAfter` (liste d'équipements). */
  collapsible?: boolean;
  options: PillOption[];
}

/**
 * Choix UNIQUE en pastilles : `role="radiogroup"` / `role="radio"`, une
 * seule pastille dans l'ordre de tabulation (la sélectionnée), flèches,
 * Début et Fin pour se déplacer ET sélectionner — le comportement attendu
 * d'un groupe de boutons radio.
 *
 * `collapseAfter` : au-delà, les options des sous-groupes se replient
 * derrière « Afficher les N autres » (la sélection reste toujours visible).
 */
export function FilterChoiceGroup({
  labelledBy,
  groups,
  onSelect,
  collapseAfter,
}: {
  labelledBy: string;
  groups: ChoiceGroup[];
  onSelect: (value: string) => void;
  collapseAfter?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const refs = useRef(new Map<string, HTMLButtonElement>());

  // Repli : les N premières options des groupes repliables, plus la
  // sélection si elle est au-delà.
  let budget = collapseAfter ?? Number.POSITIVE_INFINITY;
  let hiddenCount = 0;
  const shown = groups.map((g) => {
    if (expanded || !g.collapsible) return g;
    const options = g.options.filter((o) => {
      if (budget > 0) { budget -= 1; return true; }
      if (o.active) return true;
      hiddenCount += 1;
      return false;
    });
    return { ...g, options };
  }).filter((g) => g.options.length > 0);

  const flat = shown.flatMap((g) => g.options);
  const activeIndex = Math.max(0, flat.findIndex((o) => o.active));

  const move = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = flat.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = index === last ? 0 : index + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = index === 0 ? last : index - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next === null) return;
    e.preventDefault();
    const target = flat[next];
    onSelect(target.value);
    refs.current.get(target.value)?.focus();
  };

  let index = -1;
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex flex-col gap-2">
      {shown.map((g) => (
        <div key={g.key} className="flex min-w-0 flex-col gap-1.5">
          {g.label && (
            <p className="text-[11px] font-medium text-[color:var(--text-muted)]" aria-hidden>
              {g.label}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {g.options.map((o) => {
              index += 1;
              const i = index;
              return (
                <button
                  key={o.value}
                  ref={(el) => { if (el) refs.current.set(o.value, el); else refs.current.delete(o.value); }}
                  type="button"
                  role="radio"
                  aria-checked={o.active}
                  aria-label={o.ariaLabel}
                  tabIndex={i === activeIndex ? 0 : -1}
                  onClick={() => onSelect(o.value)}
                  onKeyDown={(e) => move(e, i)}
                  className={`${PILL_BASE} ${o.active ? PILL_ON : PILL_OFF}`}
                >
                  {pillText(o)}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {(hiddenCount > 0 || (expanded && collapseAfter !== undefined)) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="self-start rounded text-xs text-[color:var(--text-muted)] underline transition-colors hover:text-[color:var(--text-primary)]"
        >
          {expanded ? 'Afficher moins' : `Afficher les ${hiddenCount} autres`}
        </button>
      )}
    </div>
  );
}

/** Section à choix unique. */
export function FilterChoiceSection({
  id,
  title,
  options,
  onSelect,
  className,
}: {
  id: string;
  title: string;
  options: PillOption[];
  onSelect: (value: string) => void;
  className?: string;
}) {
  return (
    <FilterSection id={id} title={title} className={className}>
      <FilterChoiceGroup labelledBy={id} groups={[{ key: 'options', options }]} onSelect={onSelect} />
    </FilterSection>
  );
}

/**
 * Panneau de filtres intégré à la page — même cadre que « Mes documents ».
 * Une colonne sur téléphone ; `columns` : grille à partir de `md`.
 */
export function FilterPanel({
  id,
  columns,
  children,
  testId,
}: {
  id: string;
  columns: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      id={id}
      data-testid={testId}
      className={`mb-[22px] -mt-1.5 grid grid-cols-1 gap-[22px] rounded-xl border border-border bg-[color:var(--bg-card)] px-[18px] py-4 ${columns}`}
    >
      {children}
    </div>
  );
}

/** Bouton « Filtres » / « Filtres · N » qui déplie le panneau (jamais un tiroir). */
export function FiltersToggleButton({
  count,
  open,
  panelId,
  onToggle,
}: {
  count: number;
  open: boolean;
  panelId: string;
  onToggle: () => void;
}) {
  return (
    <Button
      size="sm"
      variant={count > 0 ? 'secondary' : 'outline'}
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={panelId}
      className={`btn-filter ${count > 0 ? 'bg-[color:var(--accent-soft)]' : ''}`}
    >
      <SlidersHorizontal className="btn-filter-sliders-icon h-4 w-4" aria-hidden />
      {count > 0 ? `Filtres · ${count}` : 'Filtres'}
    </Button>
  );
}

interface ActiveChip {
  key: string;
  label: string;
}

/** Ligne « Filtré par … » : un filtre actif = une pastille retirable. */
export function ActiveFilterChips({
  chips,
  onRemove,
  onClear,
}: {
  chips: ActiveChip[];
  onRemove: (key: string) => void;
  onClear: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="-mt-2 mb-5 flex flex-wrap items-center gap-1.5 text-xs text-[color:var(--text-muted)]" data-testid="filtres-actifs">
      <span className="mr-1">Filtré par</span>
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onRemove(c.key)}
          aria-label={`Retirer le filtre ${c.label}`}
          className="flex max-w-full items-center gap-[5px] rounded-full bg-[color:var(--accent-soft)] py-[3px] pl-2.5 pr-1.5 font-medium text-[color:var(--text-info)] transition-colors "
        >
          <span className="truncate">{c.label}</span>
          <X className="h-3 w-3 shrink-0" aria-hidden />
        </button>
      ))}
      <button
        type="button"
        onClick={onClear}
        className="ml-1.5 underline transition-colors hover:text-[color:var(--text-primary)] rounded"
      >
        Tout effacer
      </button>
    </div>
  );
}
