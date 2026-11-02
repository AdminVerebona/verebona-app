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
 *
 * ── LOT 103F : SECTIONS REPLIABLES (OPTION) ───────────────────────────────
 *
 * `collapse` rend une section repliable : en-tête toujours visible (titre,
 * compteur « N actifs » des sélections, chevron), toute la ligne activable
 * au doigt (≥ 44 px), au clavier (Entrée / Espace : bouton natif) et
 * annoncée (`aria-expanded`, `aria-controls`). Même primitive que
 * `CollapsibleSubBlock` (Radix Collapsible) ; la zone des options reste
 * montée (`hidden` une fois fermée) : la cible d'`aria-controls` existe
 * toujours et un repli ne perd rien (« Afficher les N autres » compris).
 * Sans `collapse`, rendu inchangé (« Mon agenda »).
 *
 * `describeCount` : nom accessible des pastilles avec leur compteur
 * (« Maison, 9 documents ») — le « · 9 » affiché seul ne dit pas ce qu'il
 * compte.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

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

/** Ce que compte une pastille, en toutes lettres (« 9 documents ») — lot 103F. */
export type DescribeCount = (count: number) => string;

/** Nom accessible d'une pastille : le sien, plus son compteur décrit s'il y a lieu. */
function pillAriaLabel(option: PillOption, describeCount?: DescribeCount): string | undefined {
  if (!describeCount || option.count === null || option.count === undefined) return option.ariaLabel;
  return `${option.ariaLabel ?? option.label}, ${describeCount(option.count)}`;
}

/** Pastille de filtre à bascule (choix multiples) — FilterPill du design system. */
function FilterPill({ option, onClick, describeCount }: { option: PillOption; onClick: () => void; describeCount?: DescribeCount }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={option.active}
      aria-label={pillAriaLabel(option, describeCount)}
      className={`${PILL_BASE} ${option.active ? PILL_ON : PILL_OFF}`}
    >
      {pillText(option)}
    </button>
  );
}

/** Lot 103F — section repliable : état contrôlé par l'écran, compteur de sélections. */
export interface SectionCollapse {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Sélections actives de la section ; 0 : aucun compteur affiché. */
  activeCount: number;
}

/** « 1 actif », « 3 actifs » — sélections, jamais des documents. */
export function activeCountLabel(n: number): string {
  return `${n} actif${n > 1 ? 's' : ''}`;
}

/** Section repliable (lot 103F) : en-tête permanent, options masquées une fois repliée. */
function CollapsibleFilterSection({
  id,
  title,
  collapse,
  className = '',
  children,
}: {
  id: string;
  title: string;
  collapse: SectionCollapse;
  className?: string;
  children: ReactNode;
}) {
  const contentId = `${useId()}-options`;
  const { open, onOpenChange, activeCount } = collapse;
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div
        role="group"
        aria-labelledby={id}
        data-state={open ? 'open' : 'closed'}
        data-filter-section={id}
        className={`flex min-w-0 flex-col ${className}`}
      >
        <CollapsibleTrigger
          aria-controls={contentId}
          className="group -mx-1.5 flex min-h-11 w-[calc(100%+0.75rem)] items-center gap-2 rounded-[10px] px-1.5 text-left transition-colors hover:bg-[color:var(--accent-soft)] motion-reduce:transition-none"
        >
          <span id={id} className="vb-app-label">{title}</span>
          {activeCount > 0 && (
            <span
              data-slot="section-active-count"
              className="shrink-0 rounded-full border border-[color:var(--accent)] px-2 py-px text-[11px] font-semibold text-[color:var(--text-primary)]"
            >
              <span className="sr-only">, </span>
              <span aria-hidden>{activeCountLabel(activeCount)}</span>
              <span className="sr-only">{activeCount > 1 ? `${activeCount} filtres actifs` : '1 filtre actif'}</span>
            </span>
          )}
          <span aria-hidden className="flex-1" />
          <ChevronDown
            aria-hidden
            className="h-4 w-4 shrink-0 text-[color:var(--text-muted)] transition-transform duration-200 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
          />
        </CollapsibleTrigger>
        {/* `forceMount` : la zone (cible d'aria-controls) reste ; fermée, `hidden`. */}
        <CollapsibleContent forceMount id={contentId} hidden={!open} className="pb-1 pt-1.5">
          <div className="flex min-w-0 flex-col gap-2.5">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/** Section titrée du panneau (groupe nommé par son titre) ; repliable avec `collapse` (lot 103F). */
export function FilterSection({
  id,
  title,
  className = '',
  collapse,
  children,
}: {
  id: string;
  title: string;
  className?: string;
  collapse?: SectionCollapse;
  children: ReactNode;
}) {
  if (collapse) {
    return <CollapsibleFilterSection id={id} title={title} collapse={collapse} className={className}>{children}</CollapsibleFilterSection>;
  }
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
  collapse,
  describeCount,
}: {
  id: string;
  title: string;
  options: PillOption[];
  onToggle: (value: string) => void;
  className?: string;
  emptyText?: string;
  collapse?: SectionCollapse;
  describeCount?: DescribeCount;
}) {
  return (
    <FilterSection id={id} title={title} className={className} collapse={collapse}>
      {options.length === 0 ? (
        <p className="text-xs text-[color:var(--text-muted)]">{emptyText}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => (
            <FilterPill key={o.value} option={o} onClick={() => onToggle(o.value)} describeCount={describeCount} />
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
  describeCount,
}: {
  labelledBy: string;
  groups: ChoiceGroup[];
  onSelect: (value: string) => void;
  collapseAfter?: number;
  describeCount?: DescribeCount;
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
                  aria-label={pillAriaLabel(o, describeCount)}
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

/**
 * Ligne « Filtré par … » : un filtre actif = une pastille retirable.
 *
 * Lot 103F : `maxVisible` borne la ligne (téléphone) — au-delà, « + N
 * autres » la déplie ; `clearLabel` nomme l'action de remise à zéro
 * (« Tout effacer » par défaut, inchangé pour « Mon agenda »).
 */
export function ActiveFilterChips({
  chips,
  onRemove,
  onClear,
  clearLabel = 'Tout effacer',
  maxVisible,
}: {
  chips: ActiveChip[];
  onRemove: (key: string) => void;
  onClear: () => void;
  clearLabel?: string;
  maxVisible?: number;
}) {
  const [all, setAll] = useState(false);
  if (chips.length === 0) return null;
  const limite = maxVisible !== undefined && !all ? maxVisible : chips.length;
  const visibles = chips.slice(0, limite);
  const caches = chips.length - visibles.length;
  return (
    <div
      role="group"
      aria-label="Filtres actifs"
      className="-mt-2 mb-5 flex flex-wrap items-center gap-1.5 text-xs text-[color:var(--text-muted)]"
      data-testid="filtres-actifs"
    >
      <span className="mr-1">Filtré par</span>
      {visibles.map((c) => (
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
      {(caches > 0 || (all && maxVisible !== undefined && chips.length > maxVisible)) && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          aria-expanded={all}
          className="rounded px-1 font-medium text-[color:var(--text-info)] underline"
        >
          {all ? 'Réduire' : `+ ${caches} autre${caches > 1 ? 's' : ''}`}
        </button>
      )}
      <button
        type="button"
        onClick={onClear}
        className="ml-1.5 underline transition-colors hover:text-[color:var(--text-primary)] rounded"
      >
        {clearLabel}
      </button>
    </div>
  );
}
