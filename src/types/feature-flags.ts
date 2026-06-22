/**
 * Types pour le système de feature-flags V1
 * Correspond aux spécifications Standard / Premium / Premium Duo / Pro
 */

// Import + re-export from domain.ts — source de vérité unique
import type { PlanType, SubscriptionStatus } from '@/types/domain';
export type { PlanType, SubscriptionStatus };

export interface FeatureFlags {
  max_assets: number | 'unlimited';
  pdf_dossier_enabled: boolean;
  pdf_carnet_enabled: boolean;
  zip_export_enabled: boolean;
  maintenance_tracking: 'manual' | 'auto';
}

/**
 * Configuration des feature flags par défaut pour chaque plan
 */
export const DEFAULT_FEATURE_FLAGS: Record<PlanType, FeatureFlags> = {
  STANDARD: {
    max_assets: 2,
    pdf_dossier_enabled: false,
    pdf_carnet_enabled: false,
    zip_export_enabled: true,
    maintenance_tracking: 'manual',
  },
  PREMIUM: {
    max_assets: 'unlimited',
    pdf_dossier_enabled: true,
    pdf_carnet_enabled: true,
    zip_export_enabled: true,
    maintenance_tracking: 'manual',
  },
  PREMIUM_DUO: {
    max_assets: 15,
    pdf_dossier_enabled: true,
    pdf_carnet_enabled: true,
    zip_export_enabled: true,
    maintenance_tracking: 'manual',
  },
  PREMIUM_PRO: {
    max_assets: 'unlimited',
    pdf_dossier_enabled: true,
    pdf_carnet_enabled: true,
    zip_export_enabled: true,
    maintenance_tracking: 'manual',
  },
};

/**
 * Interface pour les informations utilisateur avec feature flags
 */
export interface UserWithFeatures {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  planType: PlanType;
  subscriptionStatus: SubscriptionStatus;
  subscriptionStartedAt?: string | null;
  planRenewalDate?: string | null;
  featureFlags?: string | null; // JSON string
}

/**
 * Interface pour la réponse complète avec feature flags parsés
 */
export interface UserFeatures extends UserWithFeatures {
  features: FeatureFlags;
}
