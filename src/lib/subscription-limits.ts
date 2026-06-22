/**
 * Subscription Limits Configuration
 * Defines the limits for each active commercial plan
 */

export const SUBSCRIPTION_LIMITS = {
  STANDARD: {
    maxAssets: 2,
    maxMembers: 1,
    maxDocumentsPerAsset: 999999,
    maxPdfExports: 0,
    maxStorageGb: 2,
  },
  PREMIUM: {
    maxAssets: 10,
    maxMembers: 1, // Owner only
    maxDocumentsPerAsset: 999999, // Unlimited
    maxPdfExports: 999999, // Unlimited
    maxStorageGb: 50,
  },
  PREMIUM_DUO: {
    maxAssets: 15,
    maxMembers: 2, // Owner + 1 member
    maxDocumentsPerAsset: 999999,
    maxPdfExports: 999999,
    maxStorageGb: 50,
  },
  PREMIUM_PRO: {
    maxAssets: 999999,
    maxMembers: 999999,
    maxDocumentsPerAsset: 999999,
    maxPdfExports: 999999,
    maxStorageGb: 500,
  }
} as const;

export type PlanType = keyof typeof SUBSCRIPTION_LIMITS;

/**
 * Get limits for a specific plan
 */
export function getPlanLimits(planType: PlanType) {
  return SUBSCRIPTION_LIMITS[planType] || SUBSCRIPTION_LIMITS.STANDARD;
}

/**
 * Check if account can add more members
 */
export function canAddMoreMembers(planType: PlanType, currentMemberCount: number): boolean {
  const limits = getPlanLimits(planType);
  return currentMemberCount < limits.maxMembers;
}

/**
 * Check if account exceeds member limit for their plan
 */
export function exceedsMemberLimit(planType: PlanType, currentMemberCount: number): boolean {
  const limits = getPlanLimits(planType);
  return currentMemberCount > limits.maxMembers;
}

/**
 * Calculate how many members need to be removed to fit the plan
 */
export function calculateExcessMembers(planType: PlanType, currentMemberCount: number): number {
  const limits = getPlanLimits(planType);
  const excess = currentMemberCount - limits.maxMembers;
  return Math.max(0, excess);
}
