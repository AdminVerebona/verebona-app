/**
 * AgendaDomainService — pure domain logic, no DB access
 */

export type ManualStatus = 'realise' | 'annule' | null;
export type EffectiveStatus = 'a_venir' | 'en_retard' | 'realise' | 'annule';
export type AttentionFlag = 'sans_bien' | 'en_retard' | 'date_incoherente' | 'donnee_distincte_a_qualifier';
export type OriginType =
  | 'manual'
  | 'asset_field'
  | 'qualified_document'
  | 'deduced_rule'
  | 'legacy_event_migration'
  | 'legacy_deadline_migration';

export interface AgendaItemRaw {
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
 */
export function computeEffectiveStatus(item: AgendaItemRaw, now: Date = new Date()): EffectiveStatus {
  if (item.manualStatus !== null && item.manualStatus !== undefined) {
    return item.manualStatus as EffectiveStatus;
  }

  const nowMs = now.getTime();

  if (item.endDate) {
    let compareMs: number;
    if (item.endTime) {
      compareMs = new Date(`${item.endDate}T${item.endTime}`).getTime();
    } else {
      // End of day
      compareMs = new Date(`${item.endDate}T23:59:59`).getTime();
    }
    return compareMs < nowMs ? 'en_retard' : 'a_venir';
  }

  if (item.startDate) {
    let compareMs: number;
    if (item.startTime) {
      compareMs = new Date(`${item.startDate}T${item.startTime}`).getTime();
    } else {
      compareMs = new Date(`${item.startDate}T23:59:59`).getTime();
    }
    return compareMs < nowMs ? 'en_retard' : 'a_venir';
  }

  return 'a_venir';
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
