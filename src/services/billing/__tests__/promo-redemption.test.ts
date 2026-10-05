/**
 * Usages des codes promotionnels Stripe — CDC BO PRO-002.
 */
import { describe, it, expect } from 'vitest';
import { extractPromotionCodeIds } from '@/services/billing/promo-redemption.service';

describe('extractPromotionCodeIds', () => {
  it('session Checkout : identifiants des codes promotionnels, dédoublonnés', () => {
    expect(extractPromotionCodeIds([
      { promotion_code: 'promo_1' },
      { promotion_code: { id: 'promo_2', code: 'ETE26' } },
      { promotion_code: 'promo_1' },
    ])).toEqual({ ids: ['promo_1', 'promo_2'], needsExpand: false });
  });

  it('coupon appliqué sans code promotionnel : ignoré', () => {
    expect(extractPromotionCodeIds([{ promotion_code: null }])).toEqual({ ids: [], needsExpand: false });
    expect(extractPromotionCodeIds(null)).toEqual({ ids: [], needsExpand: false });
  });

  it('abonnement non développé (identifiants di_…) : relecture nécessaire', () => {
    expect(extractPromotionCodeIds(['di_1'])).toEqual({ ids: [], needsExpand: true });
  });
});
