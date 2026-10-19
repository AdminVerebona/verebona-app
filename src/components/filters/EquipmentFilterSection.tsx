'use client';

/**
 * Section « Équipement » du panneau de filtres — « Mes documents », onglet
 * Documents d'un bien et « Mon agenda ». Lot 71 (71C).
 *
 * Rendue seulement quand le contexte la justifie (`model.visible` : au moins
 * un bien retenu portant au moins un équipement). Choix unique :
 * « Tous (bien et équipements) » par défaut, « Bien uniquement », puis
 * chaque équipement. Plusieurs biens : un sous-groupe par bien, et le nom
 * accessible de chaque pastille cite son bien — deux « Chaudière » de biens
 * différents ne se confondent ni à l'écran ni à la synthèse vocale.
 */
import type { EquipmentFilterModel } from '@/lib/filters/equipment-filter';
import { FilterChoiceGroup, FilterSection, type ChoiceGroup } from './FilterControls';

/** Au-delà, les équipements se replient (« Afficher les N autres »). */
export const EQUIPMENT_COLLAPSE_AFTER = 8;

export function EquipmentFilterSection({
  id,
  model,
  onSelect,
  className = '',
}: {
  id: string;
  model: EquipmentFilterModel;
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
    <FilterSection id={id} title="Équipement" className={className}>
      <div data-testid="filtre-equipement">
        <FilterChoiceGroup
          labelledBy={id}
          groups={groups}
          onSelect={onSelect}
          collapseAfter={EQUIPMENT_COLLAPSE_AFTER}
        />
      </div>
    </FilterSection>
  );
}
