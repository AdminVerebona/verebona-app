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
 * ── LA RECHERCHE N'EST PAS UN FILTRE DU PANNEAU ───────────────────────────
 *
 * Lot 97C (décision PO du 26/10/2026, UX-01 du CDC V2 annulé) : le champ de
 * recherche locale est AU-DESSUS de la liste (`LocalSearchField`), toujours
 * visible ; il s'ajoute aux filtres de ce panneau en intersection, sans les
 * remplacer ni les effacer.
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
 *
 * ── LOT 71 : COMPOSANTS PARTAGÉS AVEC « MON AGENDA », FILTRE ÉQUIPEMENT ───
 *
 * Pastilles, sections, panneau et ligne « Filtré par … » vivent désormais
 * dans `components/filters/FilterControls.tsx`, montés à l'identique par
 * « Mon agenda » (dont le tiroir de filtres a disparu). La section
 * « Équipement » apparaît dès qu'un bien retenu (filtre Bien, ou l'onglet
 * d'un bien) porte au moins un équipement.
 *
 * Lot 75B : section « Pièce » (documents directs de la pièce ET documents
 * de ses équipements), juste au-dessus d'« Équipement », dans les mêmes
 * conditions (un bien retenu qui possède au moins une pièce).
 *
 * ── LOT 103F : SECTIONS REPLIABLES, DATES, SENS DES NOMBRES ───────────────
 *
 * Chaque section (Bien, Rubrique, Type, Pièce, Équipement, Date du
 * document, Date d'ajout) se replie indépendamment des autres (pas
 * d'accordéon exclusif) ; l'état vient de `filter-sections.ts` et ne touche
 * jamais aux filtres. L'en-tête d'une section porte « N actifs » (sélections)
 * — distinct du « · N » des pastilles (documents).
 *
 * Le « · N » d'une pastille compte les documents du périmètre (compte ou
 * bien de l'onglet, recherche locale comprise) qui portent cette valeur, les
 * AUTRES filtres ignorés : Bien, Rubrique et Type ne se restreignent pas
 * entre eux ni par les dates. Pièce et Équipement comptent dans les biens
 * retenus (et l'un dans l'autre). Calcul serveur sur tout le périmètre
 * (`buildFeedMeta`), jamais sur les seuls documents chargés. Nom accessible :
 * « Maison, 9 documents » ; une ligne d'aide le dit en tête du panneau.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { EquipmentFilterModel } from '@/lib/filters/equipment-filter';
import type { RoomFilterModel } from '@/lib/filters/room-filter';
import type { DateFilterDim, DateFilterValue } from '@/lib/filters/date-filter';
import { DATE_FILTER_TITLES } from '@/lib/filters/date-filter';
import { RoomFilterSection } from '@/components/filters/RoomFilterSection';
import {
  ActiveFilterChips as SharedActiveFilterChips,
  FilterPanel,
  FilterPillSection,
  type SectionCollapse,
} from '@/components/filters/FilterControls';
import { EquipmentFilterSection } from '@/components/filters/EquipmentFilterSection';
import { DateFilterSection } from '@/components/filters/DateFilterSection';
import {
  sectionActiveCount,
  type ChipDim,
  type DocumentsContext,
  type FilterDim,
  type FilterOption,
  type FilterSectionKey,
  type ViewFilters,
} from './documents-view';

/** Nom accessible du compteur d'une pastille : des documents, jamais des sélections. */
export const describeDocumentCount = (n: number) => `${n} document${n > 1 ? 's' : ''}`;

/** Aide affichée en tête du panneau : ce que comptent les nombres des pastilles. */
export const FILTER_COUNT_HELP = 'Le nombre après chaque choix indique ses documents, sans tenir compte des autres filtres.';

/** Lignes finales, sur toute la largeur : listes potentiellement longues. */
const FULL_ROW = 'border-t border-[color:var(--border-subtle)] pt-4 md:col-span-full';

export function DocumentsFilterPanel({
  id,
  context,
  options,
  onToggle,
  equipment,
  onEquipment,
  room,
  onRoom,
  filters,
  onDate,
  sections,
}: {
  id: string;
  context: DocumentsContext;
  options: { biens: FilterOption[]; rubrics: FilterOption[]; types: FilterOption[] };
  onToggle: (dim: FilterDim, value: string) => void;
  /** Lot 71 : modèle du filtre Équipement (masqué si `visible` est faux). */
  equipment?: EquipmentFilterModel;
  onEquipment?: (value: string) => void;
  /** Lot 75B : modèle du filtre Pièce (masqué si `visible` est faux). */
  room?: RoomFilterModel;
  onRoom?: (value: string) => void;
  /** Lot 103F : filtres en cours (compteurs « N actifs », périodes). */
  filters?: ViewFilters;
  /** Lot 103F : pose ou retire une période ; absent : sections de dates masquées. */
  onDate?: (dim: DateFilterDim, value: DateFilterValue | null) => void;
  /** Lot 103F : état ouvert / fermé des sections ; absent : sections non repliables. */
  sections?: { open: Record<FilterSectionKey, boolean>; onOpenChange: (section: FilterSectionKey, open: boolean) => void };
}) {
  // Dans l'onglet d'un bien, le périmètre est déjà le bien : pas de filtre Bien.
  const avecBien = context === 'mes-documents';
  const collapse = (key: FilterSectionKey): SectionCollapse | undefined => (sections ? {
    open: sections.open[key],
    onOpenChange: (v) => sections.onOpenChange(key, v),
    activeCount: filters ? sectionActiveCount(filters, key) : 0,
  } : undefined);
  return (
    <FilterPanel
      id={id}
      testId="documents-filtres"
      columns={`${sections ? 'gap-y-1.5 md:gap-y-[22px] ' : ''}${avecBien ? 'md:grid-cols-[.8fr_1fr_1.4fr]' : 'md:grid-cols-[1fr_1.4fr]'}`}
    >
      <p className="m-0 text-xs text-[color:var(--text-muted)] md:col-span-full" data-testid="aide-compteurs">
        {FILTER_COUNT_HELP}
      </p>
      {avecBien && (
        <FilterPillSection
          id={`${id}-bien`}
          title="Bien"
          options={options.biens}
          onToggle={(v) => onToggle('biens', v)}
          collapse={collapse('bien')}
          describeCount={describeDocumentCount}
        />
      )}
      <FilterPillSection
        id={`${id}-rubrique`}
        title="Rubrique"
        options={options.rubrics}
        onToggle={(v) => onToggle('rubrics', v)}
        collapse={collapse('rubrique')}
        describeCount={describeDocumentCount}
      />
      <FilterPillSection
        id={`${id}-type`}
        title="Type"
        options={options.types}
        onToggle={(v) => onToggle('types', v)}
        collapse={collapse('type')}
        describeCount={describeDocumentCount}
      />
      {/* Lignes finales, sur toute la largeur : pièces et équipements peuvent être nombreux. */}
      {room && onRoom && (
        <RoomFilterSection
          id={`${id}-piece`}
          model={room}
          onSelect={onRoom}
          className={FULL_ROW}
          collapse={collapse('piece')}
          describeCount={describeDocumentCount}
        />
      )}
      {equipment && onEquipment && (
        <EquipmentFilterSection
          id={`${id}-equipement`}
          model={equipment}
          onSelect={onEquipment}
          className={FULL_ROW}
          collapse={collapse('equipement')}
          describeCount={describeDocumentCount}
        />
      )}
      {/* Lot 103F : deux dates distinctes, jamais confondues. */}
      {onDate && (
        <div className={`grid grid-cols-1 gap-y-1.5 md:grid-cols-2 md:gap-x-[22px] ${FULL_ROW}`}>
          <DateFilterSection
            id={`${id}-date-document`}
            title={DATE_FILTER_TITLES.documentDate}
            value={filters?.documentDate}
            onChange={(v) => onDate('documentDate', v)}
            allowNone
            collapse={collapse('dateDocument')}
          />
          <DateFilterSection
            id={`${id}-date-ajout`}
            title={DATE_FILTER_TITLES.addedDate}
            value={filters?.addedDate}
            onChange={(v) => onDate('addedDate', v)}
            allowNone={false}
            collapse={collapse('dateAjout')}
          />
        </div>
      )}
    </FilterPanel>
  );
}

/** Ligne « Filtré par … » (composant partagé), adaptée aux dimensions des documents. */
export function ActiveFilterChips({
  chips,
  onRemove,
  onClear,
}: {
  chips: Array<{ dim: ChipDim; value: string; label: string }>;
  onRemove: (dim: ChipDim, value: string) => void;
  onClear: () => void;
}) {
  // Lot 103F : synthèse compacte (quatre pastilles, puis « + N autres ») et
  // action harmonisée « Réinitialiser les filtres » (sélections seulement :
  // l'état ouvert / fermé des sections ne change pas).
  return (
    <SharedActiveFilterChips
      chips={chips.map((c) => ({ key: `${c.dim}:${c.value}`, label: c.label }))}
      onRemove={(key) => {
        const c = chips.find((x) => `${x.dim}:${x.value}` === key);
        if (c) onRemove(c.dim, c.value);
      }}
      onClear={onClear}
      clearLabel="Réinitialiser les filtres"
      maxVisible={ACTIVE_CHIPS_MAX_VISIBLE}
    />
  );
}

/** Pastilles de la synthèse affichées avant « + N autres » (téléphone compris). */
export const ACTIVE_CHIPS_MAX_VISIBLE = 4;
