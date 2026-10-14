/**
 * AgendaDomainService — pure domain logic, no DB access
 */
import { agendaDatePassed, isPastHistoricalUnconfirmed, type AgendaNatureSignals } from './agenda-historical';

export type ManualStatus = 'realise' | 'annule' | null;
/**
 * Statut effectif (lu, jamais écrit) — D17 (lot 53) : cinq états distincts
 *   a_venir      prévu / à venir
 *   en_retard    date échue (échéance passée sans statut)
 *   a_confirmer  statut à confirmer (fait passé sans preuve de réalisation)
 *   realise      réalisé (statut établi)
 *   annule       annulé
 */
export type EffectiveStatus = 'a_venir' | 'en_retard' | 'a_confirmer' | 'realise' | 'annule';
export type AttentionFlag = 'sans_bien' | 'en_retard' | 'date_incoherente' | 'donnee_distincte_a_qualifier';
export type OriginType =
  | 'manual'
  | 'asset_field'
  | 'qualified_document'
  | 'deduced_rule'
  | 'legacy_event_migration'
  | 'legacy_deadline_migration';

export interface AgendaItemRaw extends AgendaNatureSignals {
  startDate: string | null;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
  manualStatus: ManualStatus;
}

export interface ResolvedLink {
  id: number;
  resolvedAssetId: number | null;
}

export interface AgendaItemWithResolvedLinks {
  directAssetIds: number[];
  fileLinks: ResolvedLink[];
  roomLinks: ResolvedLink[];
  equipmentLinks: ResolvedLink[];
}

export interface DateTimeInput {
  startDate?: string | null;
  startTime?: string | null;
  endDate?: string | null;
  endTime?: string | null;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface AgendaDataConflictRef {
  id: number;
  requiresQualification: boolean;
  currentDecision: string;
}

/**
 * computeEffectiveStatus
 * Algorithm per plan §0.2
 *
 * Lot 47B : un fait HISTORICAL passé n'est jamais « en retard ». Lot 53
 * (D17) : sans statut, il est « à confirmer », plus « réalisé » — une date
 * passée ne prouve pas la réalisation. Calcul de lecture, rien n'est écrit.
 * Règle partagée : `agenda-historical.ts`.
 */
export function computeEffectiveStatus(item: AgendaItemRaw, now: Date = new Date()): EffectiveStatus {
  if (item.manualStatus !== null && item.manualStatus !== undefined && item.manualStatus !== ('' as ManualStatus)) {
    return item.manualStatus as EffectiveStatus;
  }
  const passee = agendaDatePassed(item, now);
  if (passee === null) return 'a_venir';
  if (!passee) return 'a_venir';
  return isPastHistoricalUnconfirmed(item, now) ? 'a_confirmer' : 'en_retard';
}

/**
 * hasDirectOrIndirectAssetContext
 * Returns true if the item has at least one direct asset link
 * or at least one indirect asset link via file/room/equipment
 */
export function hasDirectOrIndirectAssetContext(item: AgendaItemWithResolvedLinks): boolean {
  if (item.directAssetIds.length > 0) return true;
  for (const link of item.fileLinks) {
    if (link.resolvedAssetId !== null) return true;
  }
  for (const link of item.roomLinks) {
    if (link.resolvedAssetId !== null) return true;
  }
  for (const link of item.equipmentLinks) {
    if (link.resolvedAssetId !== null) return true;
  }
  return false;
}

/**
 * computeAttentionFlags
 * All computed at read time, never stored.
 */
export function computeAttentionFlags(
  item: AgendaItemRaw & AgendaItemWithResolvedLinks & { requiresQualification?: boolean },
  pendingConflicts: AgendaDataConflictRef[],
  now: Date = new Date()
): AttentionFlag[] {
  const flags: AttentionFlag[] = [];
  const effective = computeEffectiveStatus(item, now);

  if (!hasDirectOrIndirectAssetContext(item)) {
    flags.push('sans_bien');
  }

  if (effective === 'en_retard') {
    flags.push('en_retard');
  }

  const hasDateConflict = pendingConflicts.some(
    c => c.currentDecision === 'pending' && !c.requiresQualification
  );
  if (hasDateConflict) {
    flags.push('date_incoherente');
  }

  if (item.requiresQualification) {
    flags.push('donnee_distincte_a_qualifier');
  }

  return flags;
}

/**
 * validateTemporalConstraints
 * Validates date/time input per plan §0.4
 */
export function validateTemporalConstraints(input: DateTimeInput): ValidationError[] {
  const errors: ValidationError[] = [];
  const { startDate, startTime, endDate, endTime } = input;

  if (startTime && !startDate) {
    errors.push({ field: 'startTime', message: 'startTime requiert startDate' });
  }
  if (endDate && !startDate) {
    errors.push({ field: 'endDate', message: 'endDate requiert startDate' });
  }
  if (endDate && startDate && endDate < startDate) {
    errors.push({ field: 'endDate', message: 'endDate ne peut pas être avant startDate' });
  }
  if (endTime && (!endDate || !startTime)) {
    errors.push({ field: 'endTime', message: 'endTime requiert endDate et startTime' });
  }
  if (endDate && startDate && endDate === startDate && endTime && startTime && endTime <= startTime) {
    errors.push({ field: 'endTime', message: 'endTime doit être après startTime quand les dates sont identiques' });
  }

  return errors;
}

/**
 * validateLinkCoherence
 * Per plan §0.6
 */
export function validateLinkCoherence(
  assetIds: number[],
  fileLinks: ResolvedLink[],
  roomLinks: ResolvedLink[],
  equipmentLinks: ResolvedLink[]
): ValidationError[] {
  const errors: ValidationError[] = [];

  // If direct assets exist, each indirect link must be coherent with at least one
  if (assetIds.length > 0) {
    const assetSet = new Set(assetIds);

    for (const link of fileLinks) {
      if (link.resolvedAssetId !== null && !assetSet.has(link.resolvedAssetId)) {
        errors.push({ field: 'fileLinks', message: `Document #${link.id} appartient à un bien non sélectionné` });
      }
    }
    for (const link of roomLinks) {
      if (link.resolvedAssetId !== null && !assetSet.has(link.resolvedAssetId)) {
        errors.push({ field: 'roomLinks', message: `Pièce #${link.id} appartient à un bien non sélectionné` });
      }
    }
    for (const link of equipmentLinks) {
      if (link.resolvedAssetId !== null && !assetSet.has(link.resolvedAssetId)) {
        errors.push({ field: 'equipmentLinks', message: `Équipement #${link.id} appartient à un bien non sélectionné` });
      }
    }
  }

  return errors;
}
