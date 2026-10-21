'use client';

/**
 * Section « Pièce » du panneau de filtres — « Mes documents », onglet
 * Documents d'un bien et « Mon agenda ». Lot 75 (75B).
 *
 * Même présentation que la section « Équipement » (lot 71) : choix unique
 * en pastilles, « Toutes les pièces » par défaut, un sous-groupe par bien
 * quand plusieurs biens sont retenus. Rendue seulement si un bien retenu
 * possède au moins une pièce (`model.visible`). Ordinateur et téléphone :
 * même composant (les pastilles passent à la ligne).
 */
import type { RoomFilterModel } from '@/lib/filters/room-filter';
import { FilterChoiceGroup, FilterSection, type ChoiceGroup } from './FilterControls';
import { EQUIPMENT_COLLAPSE_AFTER } from './EquipmentFilterSection';

export function RoomFilterSection({
  id,
  model,
  onSelect,
  className = '',
}: {
  id: string;
  model: RoomFilterModel;
  onSelect: (value: string) => void;
  className?: string;
}) {
  if (!model.visible) return null;
  const groups: ChoiceGroup[] = [
    { key: 'general', options: model.general },
    ...model.groups.map((g) => ({
      key: `bien-${g.assetId}`,
      label: model.multi && g.assetName ? g.assetName : undefined,
      collapsible: true,
      options: g.options,
    })),
  ];
  return (
    <FilterSection id={id} title="Pièce" className={className}>
      <div data-testid="filtre-piece">
        <FilterChoiceGroup labelledBy={id} groups={groups} onSelect={onSelect} collapseAfter={EQUIPMENT_COLLAPSE_AFTER} />
      </div>
    </FilterSection>
  );
}
