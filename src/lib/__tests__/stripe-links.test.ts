/**
 * Liens « Ouvrir dans Stripe » — CDC Back-Office V1 SUB-011, SUB-012, UX-008.
 */
import { describe, it, expect } from 'vitest';
import { stripeDashboardUrl, currentStripeMode } from '@/lib/stripe-links';

describe('stripeDashboardUrl', () => {
  it('ouvre l’objet exact en mode live', () => {
    expect(stripeDashboardUrl('subscriptions', 'sub_123', 'live')).toBe('https://dashboard.stripe.com/subscriptions/sub_123');
    expect(stripeDashboardUrl('customers', 'cus_ABC', 'live')).toBe('https://dashboard.stripe.com/customers/cus_ABC');
  });

  it('préfixe /test en mode test', () => {
    expect(stripeDashboardUrl('invoices', 'in_9', 'test')).toBe('https://dashboard.stripe.com/test/invoices/in_9');
  });

  it('déduit le mode de la clé serveur', () => {
    expect(currentStripeMode({ STRIPE_SECRET_KEY: 'sk_test_x' } as unknown as NodeJS.ProcessEnv)).toBe('test');
    expect(currentStripeMode({ STRIPE_SECRET_KEY: 'rk_live_x' } as unknown as NodeJS.ProcessEnv)).toBe('live');
    expect(currentStripeMode({} as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  it('refuse un identifiant absent ou suspect (injection dans le href)', () => {
    expect(stripeDashboardUrl('customers', null, 'live')).toBeNull();
    expect(stripeDashboardUrl('customers', '', 'live')).toBeNull();
    expect(stripeDashboardUrl('customers', '../../settings', 'live')).toBeNull();
    expect(stripeDashboardUrl('customers', 'cus_1?x=javascript:', 'live')).toBeNull();
  });

  it('mode inconnu : lien live (sans effet de bord si l’objet est en test)', () => {
    expect(stripeDashboardUrl('payments', 'pi_1', null)).toBe('https://dashboard.stripe.com/payments/pi_1');
  });
});
