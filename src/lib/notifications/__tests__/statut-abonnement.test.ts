/**
 * Notifications de changement de statut du compte.
 *
 * Le libellé porte l'information : l'offre obtenue, au format demandé
 * « Votre offre a été modifiée. Nouvelle offre : Premium ».
 * Libellés : `subscription-messages.ts` (partagé avec la cloche).
 */
import { describe, it, expect } from 'vitest';
import { getCatalogEntry } from '@/lib/notifications/catalog';

const rendre = (type: string, payload: Record<string, unknown>) =>
  getCatalogEntry(type)!.render(payload);

describe('activation du compte', () => {
  it('annonce l’offre avec laquelle le compte est activé', () => {
    expect(rendre('SUBSCRIPTION_ACTIVATED', { planCode: 'STANDARD', planLabel: 'Standard' }).bellBody)
      .toBe('Votre offre a été activée. Nouvelle offre : Standard');
  });

  it('précise la formule quand elle est connue', () => {
    expect(rendre('SUBSCRIPTION_ACTIVATED', { planCode: 'PREMIUM', planLabel: 'Premium', billingPeriod: 'yearly' }).bellBody)
      .toBe('Votre offre a été activée. Nouvelle offre : Premium (formule annuelle)');
  });

  it('refuse un payload sans offre', () => {
    expect(getCatalogEntry('SUBSCRIPTION_ACTIVATED')!.payloadSchema.safeParse({}).success).toBe(false);
  });

  it('lien profond conservé pour le push et l’email', () => {
    expect(getCatalogEntry('SUBSCRIPTION_ACTIVATED')!.deepLink({})).toBe('/mon-compte/offres');
  });
});

describe('changement d’offre', () => {
  it('annonce une montée en gamme', () => {
    const r = rendre('SUBSCRIPTION_CHANGED', {
      planCode: 'PREMIUM', planLabel: 'Premium',
      previousPlanCode: 'STANDARD', previousPlanLabel: 'Standard', direction: 'upgrade',
    });
    expect(r.bellBody).toBe('Votre offre a été modifiée. Nouvelle offre : Premium');
    expect(r.bellTitle).toBe('Offre modifiée');
  });

  it('annonce une baisse de gamme en nommant la nouvelle offre', () => {
    expect(rendre('SUBSCRIPTION_CHANGED', {
      planCode: 'STANDARD', planLabel: 'Standard',
      previousPlanCode: 'PREMIUM', previousPlanLabel: 'Premium', direction: 'downgrade',
    }).bellBody).toBe('Votre offre a été modifiée. Nouvelle offre : Standard');
  });

  it('exige le sens du changement', () => {
    expect(getCatalogEntry('SUBSCRIPTION_CHANGED')!
      .payloadSchema.safeParse({ planCode: 'PREMIUM', planLabel: 'Premium' }).success).toBe(false);
  });

  it('dans la cloche, ces notifications ne sont pas cliquables (le clic marque lu)', () => {
    const src = require('fs').readFileSync(require('path').join(process.cwd(), 'src/components/NotificationBell.tsx'), 'utf-8');
    expect(src).toContain('if (isSubscriptionNotification(type)) return null;');
    expect(src).not.toMatch(/type === 'SUBSCRIPTION_CHANGED'[^\n]*\n?[^\n]*'\/mon-compte\/offres'/);
  });
});
