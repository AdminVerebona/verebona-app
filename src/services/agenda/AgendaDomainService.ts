/**
 * AgendaDomainService — pure domain logic, no DB access
 *
 * Lot 113P (#715, décision PO du 06/11/2026) : un événement EXISTE à une date
 * ou une période ; il n'a PLUS de statut métier (« À venir », « Date échue »,
 * « Statut à confirmer », « Réalisé », « Annulé », choix manuel / automatique).
 * Le calcul de « statut effectif » (lots 53, 103D, 111R, 112G) est SUPPRIMÉ :
 * plus aucun lecteur ni écrivain. La date suffit à situer l'événement ; un
 * événement inexistant ou erroné est SUPPRIMÉ par l'utilisateur.
 * La colonne `agenda_items.manual_status` reste en base (obsolète, neutralisée
 * par la migration 1526) ; aucun flux ne la lit ni ne l'écrit.
 */
import type { AgendaNatureSignals } from './agenda-historical';

/**
 * Signaux d'attention calculés à la lecture. Lot 113P : plus de signal
 * « en_retard » (une date passée n'est ni un retard ni une action due).
 */
export type AttentionFlag = 'sans_bien' | 'date_incoherente' | 'donnee_distincte_a_qualifier';

/** Données d'un élément lues par les signaux (dates conservées pour la compatibilité des appelants). */
interface AgendaItemRaw extends AgendaNatureSignals {
  startDate?: string | null;
  startTime?: string | null;
  endDate?: string | null;
  endTime?: string | null;
}

export interface ResolvedLink {
  id: number;
  resolvedAssetId: number | null;
}

interface AgendaItemWithResolvedLinks {
  directAssetIds: number[];
  fileLinks: ResolvedLink[];
  roomLinks: ResolvedLink[];
  equipmentLinks: ResolvedLink[];
}

interface DateTimeInput {
  startDate?: string | null;
  startTime?: string | null;
  endDate?: string | null;
  endTime?: string | null;
}

interface ValidationError {
  field: string;
  message: string;
}

interface AgendaDataConflictRef {
  id: number;
  requiresQualification: boolean;
  currentDecision: string;
}

/**
 * Lot 111R — date de référence d'une lecture : instant fourni, sinon début
 * de la journée `today` (AAAA-MM-JJ, heure locale du serveur) — un élément
 * daté de `today` sans heure n'est donc pas encore passé (règle historique de
 * la Timeline, identique à `agendaDatePassed`).
 */
export function referenceInstant(today: string, now?: Date | null): Date {
  return now ?? new Date(`${today}T00:00:00`);
}

/**
 * hasDirectOrIndirectAssetContext
 * Returns true if the item has at least one direct asset link
 * or at least one indirect asset link via file/room/equipment
 */
function hasDirectOrIndirectAssetContext(item: AgendaItemWithResolvedLinks): boolean {
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
): AttentionFlag[] {
  const flags: AttentionFlag[] = [];

  if (!hasDirectOrIndirectAssetContext(item)) {
    flags.push('sans_bien');
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
