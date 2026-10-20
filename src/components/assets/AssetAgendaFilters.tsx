'use client';

/**
 * Panneau de filtres de l'onglet Agenda d'un bien — lot 72 (72E).
 *
 * Mêmes composants que « Mon agenda » (`FilterControls`, section partagée
 * `EquipmentFilterSection` du lot 71C), un seul panneau pour tous les
 * écrans : une colonne sur téléphone, grille à partir de `md`.
 */
import type { EquipmentFilterModel } from '@/lib/filters/equipment-filter';
import type { AgendaPeriod } from '@/lib/agenda/agenda-filters';
import { ASSET_AGENDA_PERIOD_OPTIONS, type AssetAgendaView } from '@/lib/agenda/asset-agenda-filters';
import { FilterChoiceSection, FilterPanel, FilterPillSection } from '@/components/filters/FilterControls';
import { EquipmentFilterSection } from '@/components/filters/EquipmentFilterSection';

export function AssetAgendaFilterPanel({
  id,
  view,
  period,
  includeCancelled,
  equipment,
  onPeriod,
  onToggleCancelled,
  onEquipment,
}: {
  id: string;
  view: AssetAgendaView;
  period: AgendaPeriod;
  includeCancelled: boolean;
  equipment: EquipmentFilterModel;
  onPeriod: (value: AgendaPeriod) => void;
  onToggleCancelled: () => void;
  onEquipment: (value: string) => void;
}) {
  return (
    <FilterPanel id={id} testId="agenda-bien-filtres" columns="md:grid-cols-2">
      {/* Vue annuelle : toute l'année, comme « Mon agenda » — pas de période. */}
      {view !== 'year' && (
        <FilterChoiceSection
          id={`${id}-periode`}
          title="Période"
          options={ASSET_AGENDA_PERIOD_OPTIONS.map((o) => ({ ...o, active: o.value === period }))}
          onSelect={(v) => onPeriod(v as AgendaPeriod)}
        />
      )}
      <FilterPillSection
        id={`${id}-statut`}
        title="Statut"
        options={[{ value: 'cancelled', label: 'Afficher les annulés', active: includeCancelled }]}
        onToggle={onToggleCancelled}
      />
      <EquipmentFilterSection
        id={`${id}-equipement`}
        model={equipment}
        onSelect={onEquipment}
        className="border-t border-[color:var(--border-subtle)] pt-4 md:col-span-full"
      />
    </FilterPanel>
  );
}
