import { assetSupportsRooms } from '@/lib/asset-capabilities';
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

/** PENDING_DELETION : compte clôturé par son utilisateur, suppression à J+30 (migration 0206). */
export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DELETED', 'PENDING_DELETION'] as const;
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
 * accounts.subscriptionStatus — état du cycle de vie de l'abonnement.
 * Convention : SCREAMING_SNAKE_CASE pour cohérence avec USER_STATUSES.
 * Valeur canonique : CANCELED (orthographe Stripe/américaine, pas CANCELLED).
 *
 * Signification, attribution, droits et transitions de chaque statut :
 * `lib/billing/subscription-status.ts`. PAST_DUE_GRACE et UNPAID_RECOVERY
 * n'existent plus sur le compte (migration 0250, APP-FUNC-31) : un impayé est
 * PAST_DUE, restreint dès l'échec de paiement.
 */
export const SUBSCRIPTION_STATUSES = [
  'NONE',
  'TRIALING',
  'ACTIVE',
  'CANCELED',
  'PAST_DUE',
  'EXPIRED',
  'WITHDRAWN',
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
const DEVICE_TYPES = [
  'SMARTPHONE',
  'LAPTOP',
  'TABLET',
  'TV',
  'CAMERA',
  'CONSOLE',
  'HEADPHONES',
  'OTHER'
] as const;
type DeviceType = typeof DEVICE_TYPES[number];

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
const SPORT_TYPES = [
  'DRONE',
  'SURF',
  'SKI',
  'INDOOR_BIKE',
  'SCOOTER',
  'CAMPING',
  'OTHER'
] as const;
type SportType = typeof SPORT_TYPES[number];

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
const HOME_ITEM_TYPES = [
  'KITCHEN_ROBOT',
  'VACUUM',
  'CLEANER',
  'TOOLS',
  'SMALL_APPLIANCE',
  'OTHER'
] as const;
type HomeItemType = typeof HOME_ITEM_TYPES[number];

export const HOME_ITEM_TYPE_LABELS: Record<HomeItemType, string> = {
  KITCHEN_ROBOT: 'Robot cuisine',
  VACUUM: 'Aspirateur',
  CLEANER: 'Nettoyeur',
  TOOLS: 'Outillage',
  SMALL_APPLIANCE: 'Petit électroménager',
  OTHER: 'Autre',
};

// Substructure and Equipment types
export interface Substructure {
  id: number;
  assetId: number;
  name: string;
  createdAt?: string;
  updatedAt?: string;
}

const EQUIPMENT_STATUSES = [
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

// Document types : plus de liste ici (lot 30 — l'ancienne `DOCUMENT_TYPES`
// ne connaissait que 6 des codes stockés et n'était plus lue). Types V2 :
// `lib/referential/v2` ; codes V1 : `lib/document-type-constants` ;
// traduction de tout code : `lib/referential/document-codes`.

// Document AI analysis states (null = Standard / non applicable)
const DOCUMENT_ANALYSIS_STATES = [
  'UPLOADING',
  'UPLOADED',
  'ANALYZING',
  'ANALYZED',
  // Lot 71B : ancien état « à valider » — plus jamais écrit (pas de validation
  // sur les fiches) ; encore lu pour les documents en attente de reprise
  // (`document-validation-reprise`), affiché comme « analysé ».
  'VALIDATION_REQUIRED',
  'CONFLICT_DETECTED',
  'ANALYSIS_FAILED',
] as const;
type DocumentAnalysisState = typeof DOCUMENT_ANALYSIS_STATES[number];

const TERMINAL_ANALYSIS_STATES: DocumentAnalysisState[] = [
  'ANALYZED',
  'VALIDATION_REQUIRED',
  'CONFLICT_DETECTED',
  'ANALYSIS_FAILED',
];

export function isTerminalAnalysisState(state: string | null): boolean {
  if (!state) return true;
  return TERMINAL_ANALYSIS_STATES.includes(state as DocumentAnalysisState);
}

// ── Validation helpers ────────────────────────────────────────────────────────

/**
 * isPremiumPlan — retourne true pour tous les plans payants.
 */
export function isPremiumPlan(planType: string): boolean {
  const p = (planType || '').toUpperCase();
  return p === 'STANDARD' || p === 'PREMIUM' || p === 'PREMIUM_DUO' || p === 'PREMIUM_PRO';
}

export function isValidObjectCategory(value: string): value is ObjectCategory {
  return OBJECT_CATEGORIES.includes(value as ObjectCategory);
}

export function isValidEquipmentStatus(value: string): value is EquipmentStatus {
  return EQUIPMENT_STATUSES.includes(value as EquipmentStatus);
}

/**
 * Checks if an asset type supports structural features like substructures and equipment.
 * Liste unique : `lib/asset-capabilities` (Centre d'aide GAP-04).
 */
export function assetSupportsStructuralFeatures(asset: { category: string; subtype?: string | null }): boolean {
  return assetSupportsRooms(asset);
}
