/**
 * Service de gestion des feature-flags V1
 * Gère les limites et fonctionnalités par plan (Standard, Premium, Premium Duo, Pro)
 */

import { PlanType, FeatureFlags, DEFAULT_FEATURE_FLAGS, UserWithFeatures, UserFeatures } from '@/types/feature-flags';

/**
 * Parse les feature flags depuis JSON
 */
export function parseFeatureFlags(featureFlagsJson?: string | null): FeatureFlags | null {
  if (!featureFlagsJson) return null;
  
  try {
    return JSON.parse(featureFlagsJson) as FeatureFlags;
  } catch (error) {
    console.error('Failed to parse feature flags:', error);
    return null;
  }
}

/**
 * Récupère les feature flags pour un plan donné
 * Si des feature flags personnalisés existent (en JSON), les utiliser
 * Sinon, utiliser les valeurs par défaut du plan
 */
export function getFeatureFlags(
  planType: PlanType,
  customFeatureFlags?: string | null
): FeatureFlags {
  // Essayer de parser les feature flags personnalisés
  const parsed = parseFeatureFlags(customFeatureFlags);
  
  // Si des flags personnalisés existent, les utiliser
  if (parsed) {
    return parsed;
  }
  
  // Sinon, retourner les flags par défaut du plan
  return DEFAULT_FEATURE_FLAGS[planType] || DEFAULT_FEATURE_FLAGS.STANDARD;
}

/**
 * Enrichit un utilisateur avec ses feature flags
 */
export function getUserWithFeatures(user: UserWithFeatures): UserFeatures {
  const features = getFeatureFlags(user.planType, user.featureFlags);
  
  return {
    ...user,
    features,
  };
}

/**
 * Vérifie si un utilisateur peut créer un nouveau bien
 */
export function canCreateAsset(currentAssetCount: number, features: FeatureFlags): boolean {
  if (features.max_assets === 'unlimited') {
    return true;
  }
  
  return currentAssetCount < features.max_assets;
}

/**
 * Récupère le nombre de biens restants pour un utilisateur
 * Retourne null si illimité
 */
export function getRemainingAssets(currentAssetCount: number, features: FeatureFlags): number | null {
  if (features.max_assets === 'unlimited') {
    return null;
  }
  
  return Math.max(0, features.max_assets - currentAssetCount);
}

/**
 * Vérifie si un utilisateur a dépassé la limite de biens (cas d'expiration Premium)
 */
export function isOverAssetLimit(currentAssetCount: number, features: FeatureFlags): boolean {
  if (features.max_assets === 'unlimited') {
    return false;
  }
  
  return currentAssetCount > features.max_assets;
}

/**
 * Génère le JSON des feature flags pour stockage en base
 */
export function serializeFeatureFlags(features: FeatureFlags): string {
  return JSON.stringify(features);
}

/**
 * Crée les feature flags par défaut pour un nouveau compte
 * (toujours Standard par défaut)
 */
export function getDefaultFeatureFlagsForNewUser(): string {
  return serializeFeatureFlags(DEFAULT_FEATURE_FLAGS.STANDARD);
}

/**
 * Met à jour les feature flags lors d'un changement de plan
 */
export function updateFeatureFlagsOnPlanChange(newPlanType: PlanType): string {
  return serializeFeatureFlags(DEFAULT_FEATURE_FLAGS[newPlanType]);
}
