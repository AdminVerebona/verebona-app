/**
 * Dernier administrateur actif — CDC Back-Office V1 USR-A09, REC-USR-04.
 */
import { describe, it, expect } from 'vitest';
import {
  isActiveAdmin,
  isAdminRole,
  wouldRemoveLastActiveAdmin,
} from '@/services/admin/user-admin.service';
import { hasBillingStripeSubscription } from '@/services/account/admin-account-deletion.service';

describe('statut administrateur', () => {
  it('ADMIN et SUPER_ADMIN (historique) sont administrateurs', () => {
    expect(isAdminRole('ADMIN')).toBe(true);
    expect(isAdminRole('SUPER_ADMIN')).toBe(true);
    expect(isAdminRole('USER')).toBe(false);
    expect(isAdminRole(null)).toBe(false);
  });

  it('un administrateur désactivé n’est pas un administrateur actif', () => {
    expect(isActiveAdmin({ role: 'ADMIN', status: 'ACTIVE' })).toBe(true);
    expect(isActiveAdmin({ role: 'ADMIN', status: 'SUSPENDED' })).toBe(false);
    expect(isActiveAdmin({ role: 'USER', status: 'ACTIVE' })).toBe(false);
  });
});

describe('wouldRemoveLastActiveAdmin', () => {
  it('refuse le retrait ou la désactivation du seul administrateur actif', () => {
    expect(wouldRemoveLastActiveAdmin(1, [1])).toBe(true);
  });

  it('autorise dès qu’un autre administrateur actif existe', () => {
    expect(wouldRemoveLastActiveAdmin(1, [1, 2])).toBe(false);
  });

  it('une cible qui n’est pas administrateur actif ne déclenche jamais le refus', () => {
    expect(wouldRemoveLastActiveAdmin(3, [1])).toBe(false);
    expect(wouldRemoveLastActiveAdmin(3, [])).toBe(false);
  });

  it('deux retraits concurrents : le second voit un seul admin restant et est refusé', () => {
    // Simule la sérialisation obtenue par le verrou `FOR UPDATE` : le second
    // appel lit l'état après validation du premier.
    let admins = [1, 2];
    expect(wouldRemoveLastActiveAdmin(1, admins)).toBe(false);
    admins = admins.filter((id) => id !== 1);
    expect(wouldRemoveLastActiveAdmin(2, admins)).toBe(true);
  });
});

describe('suppression de compte : abonnement Stripe encore facturant', () => {
  it('bloque un abonnement actif, en essai ou impayé', () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      expect(hasBillingStripeSubscription({ stripeSubscriptionId: 'sub_1', status, cancelAtPeriodEnd: false })).toBe(true);
    }
  });
  it('laisse passer : pas d’abonnement, abonnement terminé, fin programmée', () => {
    expect(hasBillingStripeSubscription(null)).toBe(false);
    expect(hasBillingStripeSubscription({ stripeSubscriptionId: null, status: 'active', cancelAtPeriodEnd: false })).toBe(false);
    expect(hasBillingStripeSubscription({ stripeSubscriptionId: 'sub_1', status: 'canceled', cancelAtPeriodEnd: false })).toBe(false);
    expect(hasBillingStripeSubscription({ stripeSubscriptionId: 'sub_1', status: 'active', cancelAtPeriodEnd: true })).toBe(false);
  });
});
