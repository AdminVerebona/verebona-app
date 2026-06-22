/**
 * Domain types and enums for Verebona
 * Centralizes all business domain types used across the application.
 *
 * CONVENTION:
 *  - Enums métier utilisateur/compte : SCREAMING_SNAKE_CASE  (ex: STANDARD, ACTIVE)
 *  - Enums infrastructure/membership : snake_case minuscule  (ex: active, pending, owner)
 *  - Enums agenda (domaine FR)        : snake_case minuscule  (ex: realise, annule)
 *
 * Règle : aucun cast `as 'X' | 'Y'` ne doit ometre une valeur réelle.
 * Règle : pas de double-casse pour le même champ (choisir l'une, documenter l'autre).
 */

// ── Utilisateurs ─────────────────────────────────────────────────────────────

/** Tous les plans réels en DB — inclut legacy + nouveau modèle commercial */
export const PLAN_TYPES = [
  'STANDARD',
  'PREMIUM',
  'PREMIUM_DUO',
  'PREMIUM_PRO',
] as const;
export type PlanType = typeof PLAN_TYPES[number];

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DELETED'] as const;
export type UserStatus = typeof USER_STATUSES[number];

/** SUPER_ADMIN = compte technique Verebona, pas exposé aux utilisateurs */
export const USER_ROLES = ['USER', 'ADMIN', 'SUPER_ADMIN'] as const;
export type UserRole = typeof USER_ROLES[number];

// ── Comptes ───────────────────────────────────────────────────────────────────

/**
 * subscriptionTier — colonne DB en minuscule, reflète la couche Stripe.
 * Distinct de planType (logique métier) : un compte PREMIUM_DUO a planType=PREMIUM_DUO et subscriptionTier=pro.
 */
export const SUBSCRIPTION_TIERS = ['free', 'premium', 'pro'] as const;
export type SubscriptionTier = typeof SUBSCRIPTION_TIERS[number];

/**
 * subscriptionStatus — état du cycle de vie de l'abonnement Stripe.
 * Convention : SCREAMING_SNAKE_CASE pour cohérence avec USER_STATUSES.
 * Valeur canonique : CANCELED (orthographe Stripe/américaine, pas CANCELLED).
 */
export const SUBSCRIPTION_STATUSES = [
  'NONE',
  'ACTIVE',
  'CANCELED',
  'EXPIRED',
  'PAST_DUE',
  'PAST_DUE_GRACE',
  'UNPAID_RECOVERY',
  'TRIALING',
] as const;
export type SubscriptionStatus = typeof SUBSCRIPTION_STATUSES[number];

// ── Memberships ───────────────────────────────────────────────────────────────

/**
 * accountMemberships.status — convention snake_case minuscule (valeurs DB réelles).
 * Ne pas utiliser 'ACTIVE' majuscule pour ce champ — toujours 'active'.
 */
export const MEMBERSHIP_STATUSES = ['active', 'pending', 'removed'] as const;
export type MembershipStatus = typeof MEMBERSHIP_STATUSES[number];

/** accountMemberships.role — convention snake_case minuscule */
export const MEMBERSHIP_ROLES = ['owner', 'admin', 'member'] as const;
export type MembershipRole = typeof MEMBERSHIP_ROLES[number];

// ── Agenda ────────────────────────────────────────────────────────────────────

/** agendaItems.manualStatus — null = calculé automatiquement */
export const AGENDA_MANUAL_STATUSES = ['realise', 'annule'] as const;
export type AgendaManualStatus = typeof AGENDA_MANUAL_STATUSES[number];

/** agendaItems.originType — source de création de l'élément agenda */
export const AGENDA_ORIGIN_TYPES = [
  'manual',
  'asset_field',
  'qualified_document',
  'deduced_rule',
  'legacy_event_migration',
  'legacy_deadline_migration',
] as const;
export type AgendaOriginType = typeof AGENDA_ORIGIN_TYPES[number];

// Asset types
export const ASSET_CATEGORIES = [
  'IMMOBILIER',
  'VEHICULE',
  'MATERIEL_PRO',
  'OBJECT',
  'AUTRE'
] as const;
export type AssetCategory = typeof ASSET_CATEGORIES[number];

// Object categories (for OBJECT type assets)
export const OBJECT_CATEGORIES = [
  'OBJECT_CATEGORY_TECH',
  'OBJECT_CATEGORY_SPORT',
  'OBJECT_CATEGORY_HOME'
] as const;
export type ObjectCategory = typeof OBJECT_CATEGORIES[number];

export const OBJECT_CATEGORY_LABELS: Record<ObjectCategory, string> = {
  OBJECT_CATEGORY_TECH: 'Tech / IT / Électronique',
  OBJECT_CATEGORY_SPORT: 'Loisir / Sport',
  OBJECT_CATEGORY_HOME: 'Maison & équipement',
};

// Device types for OBJECT_CATEGORY_TECH
export const DEVICE_TYPES = [
  'SMARTPHONE',
  'LAPTOP',
  'TABLET',
  'TV',
  'CAMERA',
  'CONSOLE',
  'HEADPHONES',
  'OTHER'
] as const;
export type DeviceType = typeof DEVICE_TYPES[number];

export const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  SMARTPHONE: 'Smartphone',
  LAPTOP: 'Laptop',
  TABLET: 'Tablette',
  TV: 'TV',
  CAMERA: 'Appareil photo',
  CONSOLE: 'Console',
  HEADPHONES: 'Casque audio',
  OTHER: 'Autre',
};

// Sport types for OBJECT_CATEGORY_SPORT
export const SPORT_TYPES = [
  'DRONE',
  'SURF',
  'SKI',
  'INDOOR_BIKE',
  'SCOOTER',
  'CAMPING',
  'OTHER'
] as const;
export type SportType = typeof SPORT_TYPES[number];

export const SPORT_TYPE_LABELS: Record<SportType, string> = {
  DRONE: 'Drone',
  SURF: 'Planche de surf',
  SKI: 'Ski',
  INDOOR_BIKE: 'Vélo d\'appartement',
  SCOOTER: 'Trottinette',
  CAMPING: 'Matériel de camping',
  OTHER: 'Autre',
};

// Home item types for OBJECT_CATEGORY_HOME
export const HOME_ITEM_TYPES = [
  'KITCHEN_ROBOT',
  'VACUUM',
  'CLEANER',
  'TOOLS',
  'SMALL_APPLIANCE',
  'OTHER'
] as const;
export type HomeItemType = typeof HOME_ITEM_TYPES[number];

export const HOME_ITEM_TYPE_LABELS: Record<HomeItemType, string> = {
  KITCHEN_ROBOT: 'Robot cuisine',
  VACUUM: 'Aspirateur',
  CLEANER: 'Nettoyeur',
  TOOLS: 'Outillage',
  SMALL_APPLIANCE: 'Petit électroménager',
  OTHER: 'Autre',
};

// Object details interfaces
export interface ObjectTechDetails {
  brand?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  deviceType?: DeviceType | null;
  warrantyEndDate?: string | null;
}

export interface ObjectSportDetails {
  brand?: string | null;
  model?: string | null;
  sportType?: SportType | null;
  serialNumber?: string | null;
  sizeOrDimensions?: string | null;
}

export interface ObjectHomeDetails {
  homeItemType?: HomeItemType | null;
  brand?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  warrantyEndDate?: string | null;
}

export type ObjectDetails = ObjectTechDetails | ObjectSportDetails | ObjectHomeDetails;

export const ASSET_STATUSES = [
  'EN_SERVICE',
  'EN_PANNE',
  'EN_REPARATION',
  'VENDU',
  'DETRUIT',
  'INACTIF',
  'ARCHIVED'
] as const;
export type AssetStatus = typeof ASSET_STATUSES[number];

// Substructure and Equipment types
export interface Substructure {
  id: number;
  assetId: number;
  name: string;
  createdAt?: string;
  updatedAt?: string;
}

export const EQUIPMENT_STATUSES = [
  'EN_SERVICE',
  'EN_PANNE',
  'EN_REPARATION',
  'INACTIF'
] as const;
export type EquipmentStatus = typeof EQUIPMENT_STATUSES[number];

export interface Equipment {
  id: number;
  assetId: number;
  substructureId?: number | null;
  name: string;
  type?: string | null;
  category?: string | null;
  purchasePriceCents?: number | null;
  estimatedValueCents?: number | null;
  status: EquipmentStatus;
  createdAt?: string;
  updatedAt?: string;
}

// Document types
export const DOCUMENT_TYPES = [
  'FACTURE',
  'GARANTIE',
  'MANUEL',
  'CONTRAT',
  'CERTIFICAT',
  'AUTRE'
] as const;
export type DocumentType = typeof DOCUMENT_TYPES[number];

// Event types
export const EVENT_TYPES = [
  'ACHAT',
  'REPARATION',
  'ENTRETIEN',
  'MODIFICATION',
  'INCIDENT',
  'AUTRE'
] as const;
export type EventType = typeof EVENT_TYPES[number];

// Deadline types
export const DEADLINE_TYPES = [
  'ENTRETIEN',
  'CONTROLE_TECHNIQUE',
  'ASSURANCE',
  'GARANTIE',
  'ADMINISTRATIF',
  'AUTRE'
] as const;
export type DeadlineType = typeof DEADLINE_TYPES[number];

// File upload statuses
export const UPLOAD_STATUSES = ['PENDING', 'COMPLETED', 'FAILED'] as const;
export type UploadStatus = typeof UPLOAD_STATUSES[number];

// Document AI analysis states (null = Standard / non applicable)
export const DOCUMENT_ANALYSIS_STATES = [
  'UPLOADING',
  'UPLOADED',
  'ANALYZING',
  'ANALYZED',
  'VALIDATION_REQUIRED',
  'CONFLICT_DETECTED',
  'ANALYSIS_FAILED',
] as const;
export type DocumentAnalysisState = typeof DOCUMENT_ANALYSIS_STATES[number];

export const TERMINAL_ANALYSIS_STATES: DocumentAnalysisState[] = [
  'ANALYZED',
  'VALIDATION_REQUIRED',
  'CONFLICT_DETECTED',
  'ANALYSIS_FAILED',
];

export function isTerminalAnalysisState(state: string | null): boolean {
  if (!state) return true;
  return TERMINAL_ANALYSIS_STATES.includes(state as DocumentAnalysisState);
}

export function isValidAnalysisState(value: string): value is DocumentAnalysisState {
  return DOCUMENT_ANALYSIS_STATES.includes(value as DocumentAnalysisState);
}

// Admin audit action types
export const AUDIT_ACTION_TYPES = [
  'USER_CREATE',
  'USER_UPDATE',
  'USER_SUSPEND',
  'USER_REACTIVATE',
  'USER_DELETE',
  'ASSET_VIEW',
  'ASSET_UPDATE',
  'ASSET_DELETE',
  'FILE_VIEW',
  'FILE_DELETE',
  'EMAIL_TEMPLATE_UPDATE',
  'ASSET_TYPE_CREATE',
  'ASSET_TYPE_UPDATE',
  'ASSET_TYPE_DELETE'
] as const;
export type AuditActionType = typeof AUDIT_ACTION_TYPES[number];

// ── Validation helpers ────────────────────────────────────────────────────────

export function isValidPlanType(value: string): value is PlanType {
  return PLAN_TYPES.includes(value as PlanType);
}

export function isValidUserStatus(value: string): value is UserStatus {
  return USER_STATUSES.includes(value as UserStatus);
}

export function isValidUserRole(value: string): value is UserRole {
  return USER_ROLES.includes(value as UserRole);
}

export function isValidSubscriptionTier(value: string): value is SubscriptionTier {
  return SUBSCRIPTION_TIERS.includes(value as SubscriptionTier);
}

export function isValidSubscriptionStatus(value: string): value is SubscriptionStatus {
  return SUBSCRIPTION_STATUSES.includes(value as SubscriptionStatus);
}

export function isValidMembershipStatus(value: string): value is MembershipStatus {
  return MEMBERSHIP_STATUSES.includes(value as MembershipStatus);
}

export function isValidMembershipRole(value: string): value is MembershipRole {
  return MEMBERSHIP_ROLES.includes(value as MembershipRole);
}

export function isValidAgendaManualStatus(value: string): value is AgendaManualStatus {
  return AGENDA_MANUAL_STATUSES.includes(value as AgendaManualStatus);
}

export function isValidAgendaOriginType(value: string): value is AgendaOriginType {
  return AGENDA_ORIGIN_TYPES.includes(value as AgendaOriginType);
}

/**
 * isPremiumPlan — retourne true pour tous les plans payants.
 */
export function isPremiumPlan(planType: string): boolean {
  const p = (planType || '').toUpperCase();
  return p === 'STANDARD' || p === 'PREMIUM' || p === 'PREMIUM_DUO' || p === 'PREMIUM_PRO';
}

export function isValidAssetCategory(value: string): value is AssetCategory {
  return ASSET_CATEGORIES.includes(value as AssetCategory);
}

export function isValidAssetStatus(value: string): value is AssetStatus {
  return ASSET_STATUSES.includes(value as AssetStatus);
}

export function isValidObjectCategory(value: string): value is ObjectCategory {
  return OBJECT_CATEGORIES.includes(value as ObjectCategory);
}

export function isValidDeviceType(value: string): value is DeviceType {
  return DEVICE_TYPES.includes(value as DeviceType);
}

export function isValidSportType(value: string): value is SportType {
  return SPORT_TYPES.includes(value as SportType);
}

export function isValidHomeItemType(value: string): value is HomeItemType {
  return HOME_ITEM_TYPES.includes(value as HomeItemType);
}

export function isValidDocumentType(value: string): value is DocumentType {
  return DOCUMENT_TYPES.includes(value as DocumentType);
}

export function isValidEventType(value: string): value is EventType {
  return EVENT_TYPES.includes(value as EventType);
}

export function isValidDeadlineType(value: string): value is DeadlineType {
  return DEADLINE_TYPES.includes(value as DeadlineType);
}

export function isValidUploadStatus(value: string): value is UploadStatus {
  return UPLOAD_STATUSES.includes(value as UploadStatus);
}

export function isValidEquipmentStatus(value: string): value is EquipmentStatus {
  return EQUIPMENT_STATUSES.includes(value as EquipmentStatus);
}

/**
 * Checks if an asset type supports structural features like substructures and equipment
 */
export function assetSupportsStructuralFeatures(asset: { category: string; subtype?: string | null }): boolean {
  if (asset.category !== 'IMMOBILIER') return false;
  
  const subtype = asset.subtype?.toLowerCase() || '';
  // Authorized: Maison, Appartement, Local commercial, Studio, Villa, Propriété
  const authorized = ['maison', 'appartement', 'studio', 'local commercial', 'villa', 'propriété'];
  // Specifically disallowed: Terrain, Garage
  const disallowed = ['terrain', 'garage'];
  
  return authorized.some(a => subtype.includes(a)) && !disallowed.some(d => subtype === d);
}
