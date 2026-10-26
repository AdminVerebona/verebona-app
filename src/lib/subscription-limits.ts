/**
 * Subscription Limits Configuration
 * Defines the limits for each active commercial plan
 *
 * `maxStorageGb` : plafond d'espace de stockage par offre — 1 Go Standard,
 * 5 Go Premium, 10 Go Premium Duo (lot 26, décision produit ; remplace les
 * 2 / 10 / 15 Go du CDC Back-Office §13.1). SOURCE UNIQUE CÔTÉ CODE :
 * `@/lib/storage-quota` en dérive son repli `DEFAULT_STORAGE_LIMIT_BYTES`.
 * La valeur d'autorité en exploitation est `plan_limits.max_storage_bytes`,
 * alignée par la migration 0260.
 */

export const SUBSCRIPTION_LIMITS = {
  STANDARD: {
    maxAssets: 2,
    maxMembers: 1,
    maxDocumentsPerAsset: 999999,
    maxPdfExports: 0,
    maxStorageGb: 1,
  },
  PREMIUM: {
    maxAssets: 10,
    maxMembers: 1, // Owner only
    maxDocumentsPerAsset: 999999, // Unlimited
    maxPdfExports: 999999, // Unlimited
    maxStorageGb: 5,
  },
  PREMIUM_DUO: {
    maxAssets: 15,
    maxMembers: 2, // Owner + 1 member
    maxDocumentsPerAsset: 999999,
    maxPdfExports: 999999,
    maxStorageGb: 10,
  },
  PREMIUM_PRO: {
    maxAssets: 999999,
    maxMembers: 999999,
    maxDocumentsPerAsset: 999999,
    maxPdfExports: 999999,
    maxStorageGb: 500,
  }
} as const;
