/**
 * Types for the "À traiter" (To Process) V2 action-based view
 * CDC V2 — Refonte de la page « À traiter » Verebona
 */

export type ObjectType = 'document' | 'agenda' | 'equipment' | 'supplier' | 'asset';

export type ToProcessFamily = 'arbitrate' | 'attach' | 'confirm' | 'complete';

export type Priority = 'high' | 'medium' | 'low';

export type ToProcessStatus = 'active' | 'snoozed';

export type Source = 'manual' | 'document_ai' | 'automatic' | 'import';

export interface ToProcessContext {
  createdAt?: string;
  suggestedAssetId?: string;
  suggestedAssetLabel?: string;
  suggestedSupplierId?: string;
  suggestedSupplierLabel?: string;
  conflictingValues?: { label: string; value: string }[];
  documentId?: number;
  documentFilename?: string;
  currentValue?: string;
  detectedValue?: string;
  conflictingField?: string;
  supplierId?: number;
  candidateSupplierIds?: number[];
  fusionRunId?: number | null;
  source?: Source;
  assetName?: string;
}

export type PrimaryAction =
  | 'choose_asset'
  | 'choose_date'
  | 'confirm'
  | 'choose_other'
  | 'add_date'
  | 'resolve'
  | 'merge'
  | 'keep_separate'
  | 'fill';

export type SecondaryAction =
  | 'view_detail'
  | 'view_source_document'
  | 'snooze'
  | 'unsnooze'
  | 'choose_other';

export interface ToProcessItem {
  id: string;
  objectType: ObjectType;
  objectId: number;
  family: ToProcessFamily;
  reason: string;
  priority: Priority;
  actionTitle: string;
  objectTitle: string;
  badge: string;
  context: ToProcessContext;
  primaryAction: PrimaryAction;
  secondaryActions: SecondaryAction[];
  status: ToProcessStatus;
  createdAt: string;
}

export interface ToProcessCounters {
  arbitrate: number;
  attach: number;
  confirm: number;
  complete: number;
  priority: number;
}

export interface ToProcessResponse {
  total: number;
  counters: ToProcessCounters;
  items: ToProcessItem[];
}

export interface ToProcessFilters {
  family?: ToProcessFamily;
  objectType?: ObjectType;
  assetId?: string;
  priority?: Priority;
  status?: ToProcessStatus;
  source?: Source;
  sort?: 'priority' | 'created_at';
  view?: 'all' | 'priority' | ToProcessFamily;
}

export interface ResolvePayload {
  resolution: string;
  assetId?: string;
  date?: string;
  supplierId?: string;
  sourceSupplierIds?: string[];
  targetSupplierId?: string;
  value?: string;
}

// Family technical → UI mapping
export const FAMILY_LABELS: Record<ToProcessFamily, string> = {
  arbitrate: 'À arbitrer',
  attach: 'À rattacher',
  confirm: 'À confirmer',
  complete: 'À compléter',
};

export const FAMILY_ORDER: ToProcessFamily[] = ['arbitrate', 'confirm', 'attach', 'complete'];

export const PRIORITY_LABELS: Record<Priority, string> = {
  high: 'Haute',
  medium: 'Moyenne',
  low: 'Basse',
};

export const OBJECT_TYPE_LABELS: Record<ObjectType, string> = {
  document: 'Document',
  agenda: 'Agenda',
  equipment: 'Équipement',
  supplier: 'Fournisseur',
  asset: 'Bien',
};

// Quick view labels
export const VIEW_LABELS: Record<string, string> = {
  all: 'Tout',
  priority: 'Priorité',
  arbitrate: 'À arbitrer',
  attach: 'À rattacher',
  confirm: 'À confirmer',
  complete: 'À compléter',
};
