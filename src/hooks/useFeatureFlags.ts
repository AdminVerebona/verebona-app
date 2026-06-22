/**
 * Hook React pour accéder aux feature flags de l'utilisateur connecté
 * Utilise le hook useSession pour récupérer les données utilisateur
 */

import { useMemo } from 'react';
import { useSession } from '@/hooks/useSession';
import { getFeatureFlags, canCreateAsset, getRemainingAssets, isOverAssetLimit } from '@/lib/feature-flags';
import { FeatureFlags, PlanType, SubscriptionStatus } from '@/types/feature-flags';
import { isPremiumPlan } from '@/types/domain';

interface UseFeatureFlagsReturn {
  features: FeatureFlags;
  planType: PlanType;
  subscriptionStatus: SubscriptionStatus;
  
  // Helpers pour les biens
  canCreateAsset: (currentAssetCount: number) => boolean;
  getRemainingAssets: (currentAssetCount: number) => number | null;
  isOverAssetLimit: (currentAssetCount: number) => boolean;
  
  // Helpers pour les fonctionnalités
  canGeneratePDF: boolean;
  canExportZIP: boolean;
  
  // Status
  isPremium: boolean;
  isStandard: boolean;
  isActive: boolean;
  isCanceled: boolean;
  isExpired: boolean;
  
  isLoading: boolean;
}

export function useFeatureFlags(): UseFeatureFlagsReturn {
  const { user, isLoading } = useSession({ required: false });
  
  // Mémoïser les feature flags
  const features = useMemo(() => {
    if (!user) {
      // Valeurs par défaut si pas d'utilisateur
      return {
        max_assets: 2,
        pdf_dossier_enabled: false,
        pdf_carnet_enabled: false,
        zip_export_enabled: true,
        maintenance_tracking: 'manual' as const,
      };
    }
    
    const planType = ((user?.subscription?.plan || 'STANDARD') as string).toUpperCase() as PlanType;
    const featureFlagsJson = (user as any)?.featureFlags;
    
    return getFeatureFlags(planType, featureFlagsJson);
  }, [user]);
  
    // Mémoïser les helpers
    const helpers = useMemo(() => {
      const planType = ((user?.subscription?.plan || 'STANDARD') as string).toUpperCase() as PlanType;
      const subscriptionStatus = user?.subscription?.status || 'NONE';
      
      return {
        features,
        planType,
        subscriptionStatus: subscriptionStatus as SubscriptionStatus,

        // Helpers pour les biens
        canCreateAsset: (currentAssetCount: number) => canCreateAsset(currentAssetCount, features),
        getRemainingAssets: (currentAssetCount: number) => getRemainingAssets(currentAssetCount, features),
        isOverAssetLimit: (currentAssetCount: number) => isOverAssetLimit(currentAssetCount, features),

        // Helpers pour les fonctionnalités
        canGeneratePDF: features.pdf_dossier_enabled || features.pdf_carnet_enabled,
        canExportZIP: features.zip_export_enabled,

        // Status
        isPremium: isPremiumPlan(planType),
        isStandard: planType === 'STANDARD',
        isActive: subscriptionStatus === 'ACTIVE',
        isCanceled: subscriptionStatus === 'CANCELED',
        isExpired: subscriptionStatus === 'EXPIRED',

        isLoading,
      };
  }, [user, features, isLoading]);
  
  return helpers;
}
