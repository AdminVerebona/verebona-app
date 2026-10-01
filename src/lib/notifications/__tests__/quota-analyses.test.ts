/**
 * Notifications de quota d'analyses (ANALYSIS_QUOTA_90 / _100).
 *
 * Le quota est rattaché à la période d'essai ou à la période annuelle
 * (`account_analysis_counters.period_type`), jamais au mois : aucun libellé
 * ne doit annoncer « ce mois-ci ».
 */
import { describe, it, expect } from 'vitest';
import { getCatalogEntry } from '@/lib/notifications/catalog';
import { quotaNotificationText } from '@/lib/notifications/quota-notification-text';

const rendre = (type: string, payload: Record<string, unknown>) =>
  getCatalogEntry(type)!.render(payload);

const base = { accountId: 1, includedConsumed: 45, includedQuota: 50 };

describe('quota d’analyses : aucun libellé mensuel', () => {
  for (const type of ['ANALYSIS_QUOTA_90', 'ANALYSIS_QUOTA_100'] as const) {
    for (const periodType of ['trial', 'annual', undefined]) {
      it(`${type} (${periodType ?? 'ancienne ligne'}) ne parle pas de mois`, () => {
        const c = rendre(type, { ...base, threshold: type.endsWith('100') ? 100 : 90, periodType });
        expect(c.bellBody).not.toMatch(/mois/i);
        expect(c.bellTitle).not.toMatch(/mois/i);
      });
    }
  }
});

describe('quota d’analyses : libellé selon la période', () => {
  it('période d’essai', () => {
    expect(quotaNotificationText(90, 'trial')).toBe('Vous avez utilisé 90 % des analyses incluses pour votre période d\'essai');
    expect(quotaNotificationText(100, 'trial')).toBe('Vous avez utilisé toutes les analyses incluses pour votre période d\'essai');
  });

  it('période annuelle et anciennes lignes sans période : formulation neutre', () => {
    expect(quotaNotificationText(90, 'annual')).toBe('Vous avez utilisé 90 % des analyses incluses dans votre offre');
    expect(quotaNotificationText(90)).toBe('Vous avez utilisé 90 % des analyses incluses dans votre offre');
  });

  it('le catalogue (push, e-mail) reprend le texte de la cloche', () => {
    expect(rendre('ANALYSIS_QUOTA_100', { ...base, threshold: 100, periodType: 'trial' }).bellBody)
      .toBe(`${quotaNotificationText(100, 'trial')}.`);
  });
});
