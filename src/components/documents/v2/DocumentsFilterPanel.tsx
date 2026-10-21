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
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { EquipmentFilterModel } from '@/lib/filters/equipment-filter';
import type { RoomFilterModel } from '@/lib/filters/room-filter';
import { RoomFilterSection } from '@/components/filters/RoomFilterSection';
import { ActiveFilterChips as SharedActiveFilterChips, FilterPanel, FilterPillSection } from '@/components/filters/FilterControls';
import { EquipmentFilterSection } from '@/components/filters/EquipmentFilterSection';
import type { DocumentsContext, FilterDim, FilterOption } from './documents-view';

export function DocumentsFilterPanel({
  id,
  context,
  options,
  onToggle,
  equipment,
  onEquipment,
  room,
  onRoom,
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
}) {
  // Dans l'onglet d'un bien, le périmètre est déjà le bien : pas de filtre Bien.
  const avecBien = context === 'mes-documents';
  return (
    <FilterPanel
      id={id}
      testId="documents-filtres"
      columns={avecBien ? 'md:grid-cols-[.8fr_1fr_1.4fr]' : 'md:grid-cols-[1fr_1.4fr]'}
    >
      {avecBien && (
        <FilterPillSection id={`${id}-bien`} title="Bien" options={options.biens} onToggle={(v) => onToggle('biens', v)} />
      )}
      <FilterPillSection id={`${id}-rubrique`} title="Rubrique" options={options.rubrics} onToggle={(v) => onToggle('rubrics', v)} />
      <FilterPillSection id={`${id}-type`} title="Type" options={options.types} onToggle={(v) => onToggle('types', v)} />
      {/* Lignes finales, sur toute la largeur : pièces et équipements peuvent être nombreux. */}
      {room && onRoom && (
        <RoomFilterSection
          id={`${id}-piece`}
          model={room}
          onSelect={onRoom}
          className="border-t border-[color:var(--border-subtle)] pt-4 md:col-span-full"
        />
      )}
      {equipment && onEquipment && (
        <EquipmentFilterSection
          id={`${id}-equipement`}
          model={equipment}
          onSelect={onEquipment}
          className="border-t border-[color:var(--border-subtle)] pt-4 md:col-span-full"
        />
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
  chips: Array<{ dim: FilterDim | 'equipment' | 'piece'; value: string; label: string }>;
  onRemove: (dim: FilterDim | 'equipment' | 'piece', value: string) => void;
  onClear: () => void;
}) {
  return (
    <SharedActiveFilterChips
      chips={chips.map((c) => ({ key: `${c.dim}:${c.value}`, label: c.label }))}
      onRemove={(key) => {
        const c = chips.find((x) => `${x.dim}:${x.value}` === key);
        if (c) onRemove(c.dim, c.value);
      }}
      onClear={onClear}
    />
  );
}
