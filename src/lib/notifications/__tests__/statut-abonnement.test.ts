/**
 * Notifications de changement de statut du compte.
 *
 * Le libellé porte l'information : l'offre obtenue et le sens du changement.
 * « Offre modifiée » seul n'apprenait rien au client.
 */
import { describe, it, expect } from 'vitest';
import { getCatalogEntry } from '@/lib/notifications/catalog';

const rendre = (type: string, payload: Record<string, unknown>) =>
  getCatalogEntry(type)!.render(payload);

describe('activation du compte', () => {
  it('annonce l’offre avec laquelle le compte est activé', () => {
    expect(rendre('SUBSCRIPTION_ACTIVATED', { planCode: 'STANDARD', planLabel: 'Standard' }).bellBody)
      .toBe('Votre compte a été activé avec une offre Standard.');
  });

  it('précise la formule quand elle est connue', () => {
    expect(rendre('SUBSCRIPTION_ACTIVATED', { planCode: 'PREMIUM', planLabel: 'Premium', billingPeriod: 'yearly' }).bellBody)
      .toBe('Votre compte a été activé avec une offre Premium. Formule annuelle.');
  });

  it('refuse un payload sans offre', () => {
    expect(getCatalogEntry('SUBSCRIPTION_ACTIVATED')!.payloadSchema.safeParse({}).success).toBe(false);
  });

  it('renvoie vers les offres', () => {
    expect(getCatalogEntry('SUBSCRIPTION_ACTIVATED')!.deepLink({})).toBe('/mon-compte/offres');
  });
});

describe('changement d’offre', () => {
  it('annonce une montée en gamme', () => {
    const r = rendre('SUBSCRIPTION_CHANGED', {
      planCode: 'PREMIUM', planLabel: 'Premium',
      previousPlanCode: 'STANDARD', previousPlanLabel: 'Standard', direction: 'upgrade',
    });
    expect(r.bellBody).toBe('Votre compte a été upgradé vers une offre Premium.');
    expect(r.bellTitle).toBe('Offre mise à niveau');
  });

  it('annonce une baisse de gamme en nommant les deux offres', () => {
    expect(rendre('SUBSCRIPTION_CHANGED', {
      planCode: 'STANDARD', planLabel: 'Standard',
      previousPlanCode: 'PREMIUM', previousPlanLabel: 'Premium', direction: 'downgrade',
    }).bellBody).toBe('Votre offre est passée de Premium à Standard.');
  });

  it('exige le sens du changement', () => {
    expect(getCatalogEntry('SUBSCRIPTION_CHANGED')!
      .payloadSchema.safeParse({ planCode: 'PREMIUM', planLabel: 'Premium' }).success).toBe(false);
  });

  it('la cloche pointe vers les offres pour ces notifications', () => {
    const src = require('fs').readFileSync(require('path').join(process.cwd(), 'src/components/NotificationBell.tsx'), 'utf-8');
    expect(src).toMatch(/type === 'SUBSCRIPTION_ACTIVATED' \|\| type === 'SUBSCRIPTION_CHANGED'/);
  });
});
