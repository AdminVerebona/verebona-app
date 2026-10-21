"use client"

/**
 * Champ « Usage énergétique » du tiroir équipement (lot 70B), affiché selon
 * sa PERTINENCE (lot 75A, ticket « Affichage contextuel du champ Usage
 * énergétique »). Même composant sur desktop et mobile (le tiroir est une
 * `Sheet` unique).
 *
 * La condition métier est centralisée dans `isEnergyUsageFieldRelevant`
 * (`lib/cil/energy-equipment.ts`) : choix explicite (même « Aucun usage
 * énergétique ») ou équipement reconnu énergétique par les critères
 * structurés de la règle B6 (catégorie, type du référentiel,
 * caractéristiques CIL). Ce fichier ne fait que la présentation :
 *
 *   · consultation : ligne affichée seulement si pertinente ;
 *   · formulaire : champ présenté directement si pertinent, sinon dans une
 *     section « Options avancées » repliée (équipements atypiques) — ouverte
 *     d'office si une valeur y est choisie, pour qu'aucun choix ne soit
 *     masqué ;
 *   · une valeur n'est ENVOYÉE que si le champ est visible : le masquage ne
 *     modifie ni n'efface jamais la valeur persistée, et `null` n'est jamais
 *     transformé en « aucun ».
 */

import { ChevronDown } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  EQUIPMENT_ENERGY_USAGE_OPTIONS, ENERGY_USAGE_UNSET_LABEL, equipmentEnergyUsageLabel,
  isEnergyUsageFieldRelevant, normalizeEquipmentEnergyUsage, suggestEnergyUsageFromType,
  type CilEnergyEquipmentInput,
} from '@/lib/cil/energy-equipment';

/** Valeur du sélecteur « Usage énergétique » pour « Non renseigné » (`null` en base). */
export const ENERGY_USAGE_UNSET = 'non_renseigne';
export const energyUsageToForm = (v: unknown): string => normalizeEquipmentEnergyUsage(v) ?? ENERGY_USAGE_UNSET;
const formToValue = (v: string) => (v === ENERGY_USAGE_UNSET ? null : normalizeEquipmentEnergyUsage(v));

/** Données structurées lues pour la pertinence, hors type et usage (relues par le tiroir). */
export type EnergyUsageRelevanceBase = Pick<CilEnergyEquipmentInput, 'category' | 'energyType' | 'evacuationMode' | 'heatNetworkDeliveryStation'>;

/** Consultation : la ligne « Usage énergétique » est-elle affichée ? Pur. */
export function showEnergyUsageInView(p: { knownEnergyUsage: string | null | undefined; type: string | null | undefined; base: EnergyUsageRelevanceBase | null }): boolean {
  if (p.knownEnergyUsage === undefined) return false; // valeur pas encore lue : rien n'est affirmé
  return isEnergyUsageFieldRelevant({ ...(p.base ?? {}), type: p.type, energyUsage: p.knownEnergyUsage });
}

export interface EnergyUsageFormPresentation {
  /** `direct` : dans le formulaire standard ; `advanced` : dans « Options avancées ». */
  placement: 'direct' | 'advanced';
  /** Le champ est visible (direct, ou section avancée ouverte / porteuse d'une valeur). */
  visible: boolean;
}

/**
 * Formulaire (création / modification) : emplacement et visibilité du champ.
 * L'emplacement suit la valeur PERSISTÉE et les données structurées du
 * formulaire (le type saisi : mise à jour immédiate quand il change) ; un
 * choix fait dans la section avancée la garde ouverte. Pur.
 */
export function energyUsageFormPresentation(p: {
  persistedEnergyUsage: string | null | undefined;
  formValue: string;
  type: string | null | undefined;
  base: EnergyUsageRelevanceBase | null;
  advancedOpen: boolean;
}): EnergyUsageFormPresentation {
  const direct = isEnergyUsageFieldRelevant({ ...(p.base ?? {}), type: p.type, energyUsage: p.persistedEnergyUsage ?? null });
  if (direct) return { placement: 'direct', visible: true };
  return { placement: 'advanced', visible: p.advancedOpen || formToValue(p.formValue) !== null };
}

/**
 * Valeur à envoyer : `undefined` (champ absent du corps = inchangé côté
 * serveur) quand le champ n'est pas visible ou que la valeur persistée n'est
 * pas encore connue en modification. Pur.
 */
export function energyUsagePayload(p: { isCreateMode: boolean; knownEnergyUsage: string | null | undefined; visible: boolean; formValue: string }): string | null | undefined {
  if (!p.visible) return undefined;
  if (!p.isCreateMode && p.knownEnergyUsage === undefined) return undefined;
  return formToValue(p.formValue);
}

/** Ligne de consultation (affichée seulement si `showEnergyUsageInView`). */
export function EquipmentEnergyUsageView({ value }: { value: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3" data-testid="equipment-energy-usage-view">
      <span className="text-muted-foreground">Usage énergétique</span>
      <span className={value ? 'font-medium text-right' : 'text-muted-foreground text-right'}>{equipmentEnergyUsageLabel(value)}</span>
    </div>
  );
}

/** Champ du formulaire, à l'emplacement calculé par `energyUsageFormPresentation`. */
export function EquipmentEnergyUsageField({
  presentation, value, onChange, editable, type, advancedOpen, onAdvancedOpenChange,
}: {
  presentation: EnergyUsageFormPresentation;
  value: string;
  onChange: (v: string) => void;
  editable: boolean;
  type: string;
  advancedOpen: boolean;
  onAdvancedOpenChange: (open: boolean) => void;
}) {
  // Suggestion d'usage déduite du type (référentiel, reconnu en tête du champ),
  // proposée seulement quand l'usage n'est pas renseigné ; jamais appliquée seule.
  const suggestion = value === ENERGY_USAGE_UNSET ? suggestEnergyUsageFromType(type) : null;
  const field = (
    <div className="space-y-1.5" data-testid="equipment-energy-usage" data-placement={presentation.placement}>
      <Label htmlFor="equipment-energy-usage">Usage énergétique</Label>
      <Select value={value} onValueChange={onChange} disabled={!editable}>
        <SelectTrigger id="equipment-energy-usage"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ENERGY_USAGE_UNSET}>{ENERGY_USAGE_UNSET_LABEL}</SelectItem>
          {EQUIPMENT_ENERGY_USAGE_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {suggestion ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[color:var(--border-info)] bg-[color:var(--accent-soft)] px-3 py-2" data-testid="equipment-energy-usage-suggestion">
          <p className="text-xs text-[color:var(--text-primary)]">
            Suggestion d’après le type : <span className="font-semibold">{equipmentEnergyUsageLabel(suggestion)}</span>
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => onChange(suggestion)}>
            Confirmer
          </Button>
        </div>
      ) : (
        <p className="vb-meta">
          {presentation.placement === 'direct'
            ? 'Sert au dossier CIL (équipements à incidence énergétique). « Non renseigné » : le type décide.'
            : 'À renseigner seulement si cet équipement chauffe, refroidit, ventile, produit de l’eau chaude ou de l’énergie : il sera alors repris au dossier CIL.'}
        </p>
      )}
    </div>
  );
  if (presentation.placement === 'direct') return field;
  // Équipement non reconnu énergétique : section avancée repliée (pas d'encombrement).
  const panelId = 'equipment-energy-usage-advanced';
  const forcedOpen = presentation.visible && !advancedOpen;
  return (
    <div className="rounded-md border border-border" data-testid="equipment-energy-usage-advanced">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground disabled:cursor-default"
        aria-expanded={presentation.visible}
        aria-controls={panelId}
        // Une valeur choisie garde la section ouverte : elle n'est jamais masquée.
        disabled={forcedOpen}
        onClick={() => onAdvancedOpenChange(!advancedOpen)}
      >
        <span>Options avancées · usage énergétique</span>
        <ChevronDown className={cn('size-4 shrink-0 transition-transform', presentation.visible && 'rotate-180')} aria-hidden />
      </button>
      {presentation.visible && <div id={panelId} className="border-t border-border px-3 py-3">{field}</div>}
    </div>
  );
}
