/**
 * Notifications d'abonnement : un texte qui dit ce qui a changé
 * (« Votre offre a été modifiée. Nouvelle offre : Premium »), et qui
 * s'adapte à l'événement, au lieu de « Nouvelle notification ».
 */
import { describe, expect, it } from 'vitest';
import {
  isSubscriptionNotification,
  subscriptionNotificationText,
} from '../subscription-messages';
import { getCatalogEntry } from '../catalog';

describe('libellés des notifications d’abonnement', () => {
  it('changement d’offre : nouvelle offre nommée', () => {
    expect(subscriptionNotificationText('SUBSCRIPTION_CHANGED', {
      planCode: 'PREMIUM', planLabel: 'Premium', direction: 'upgrade',
    })).toBe('Votre offre a été modifiée. Nouvelle offre : Premium');
  });

  it('s’adapte à l’offre et à la formule', () => {
    expect(subscriptionNotificationText('SUBSCRIPTION_CHANGED', {
      planCode: 'PREMIUM_DUO', billingPeriod: 'yearly', direction: 'upgrade',
    })).toBe('Votre offre a été modifiée. Nouvelle offre : Premium Duo (formule annuelle)');
    expect(subscriptionNotificationText('SUBSCRIPTION_ACTIVATED', {
      planCode: 'STANDARD', planLabel: 'Standard', billingPeriod: 'monthly',
    })).toBe('Votre offre a été activée. Nouvelle offre : Standard (formule mensuelle)');
    expect(subscriptionNotificationText('SUBSCRIPTION_RENEWED', { planCode: 'premium' }))
      .toBe('Votre abonnement a été renouvelé. Offre : Premium');
  });

  it('changement programmé : date de prise d’effet', () => {
    expect(subscriptionNotificationText('SUBSCRIPTION_CHANGE_SCHEDULED', {
      planCode: 'STANDARD', effectiveAt: '2026-11-14T10:00:00.000Z',
    })).toBe('Changement d’offre programmé. Nouvelle offre : Standard. Prise d’effet le 14 novembre 2026.');
  });

  it('payload vide : jamais « Nouvelle notification »', () => {
    for (const type of ['SUBSCRIPTION_ACTIVATED', 'SUBSCRIPTION_CHANGED', 'SUBSCRIPTION_RENEWED', 'SUBSCRIPTION_CANCELLED']) {
      const texte = subscriptionNotificationText(type, null);
      expect(texte).toBeTruthy();
      expect(texte).not.toBe('Nouvelle notification');
    }
  });

  it('autres types : laissés à l’appelant', () => {
    expect(subscriptionNotificationText('DOCUMENT_ANALYZED', {})).toBeNull();
    expect(isSubscriptionNotification('DOCUMENT_ANALYZED')).toBe(false);
    expect(isSubscriptionNotification('SUBSCRIPTION_CHANGED')).toBe(true);
  });

  it('le catalogue serveur produit le même texte que la cloche', () => {
    const rendu = getCatalogEntry('SUBSCRIPTION_CHANGED')!.render({
      planCode: 'PREMIUM', planLabel: 'Premium', direction: 'upgrade',
    } as never);
    expect(rendu.bellBody).toBe('Votre offre a été modifiée. Nouvelle offre : Premium');
  });
});
