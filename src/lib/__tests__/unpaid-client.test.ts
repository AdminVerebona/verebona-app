/**
 * Impayé côté client : un paiement échoué n'est pas une fin d'essai.
 *
 * Tout compte restreint était présenté comme « essai terminé — aucun
 * prélèvement n'a été effectué », et renvoyé vers le choix d'une offre. Pour
 * un abonné dont la carte est refusée, c'est faux et contre-productif.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isTrialOver, isUnpaid, unpaidDeadlineLabel } from '@/lib/trial-status';
import { TRIAL_EXPIRED_MESSAGE, restrictedWriteInfo } from '@/lib/write-blocked';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const unpaid = { startedAt: '2026-09-01T10:00:00.000Z', deadlineAt: '2026-11-30T10:00:00.000Z', daysLeft: 65 };

describe('isUnpaid / isTrialOver', () => {
  it('impayé en cours sur un compte restreint : impayé, pas fin d’essai', () => {
    const data = { trial: { status: 'converted' as const }, isRestricted: true, canWrite: false, unpaid };
    expect(isUnpaid(data)).toBe(true);
    expect(isTrialOver(data)).toBe(false);
  });

  it('fin d’essai inchangée (sans impayé)', () => {
    expect(isTrialOver({ trial: { status: 'expired' }, isRestricted: true, unpaid: null })).toBe(true);
    expect(isUnpaid({ trial: { status: 'expired' }, isRestricted: true, unpaid: null })).toBe(false);
    // Offre résiliée, aucun abonnement : toujours « sans offre ».
    expect(isTrialOver({ trial: { status: 'none' }, isRestricted: true })).toBe(true);
  });

  it('cycle resté ouvert sur un compte qui peut écrire : pas d’alerte', () => {
    expect(isUnpaid({ isRestricted: false, canWrite: true, unpaid })).toBe(false);
  });

  it('pas de données : ni l’un ni l’autre', () => {
    expect(isUnpaid(null)).toBe(false);
    expect(isTrialOver(undefined)).toBe(false);
  });
});

describe('unpaidDeadlineLabel', () => {
  it('date à Paris et jours restants', () => {
    expect(unpaidDeadlineLabel(unpaid)).toBe('le 30 novembre 2026 (dans 65 jours)');
    expect(unpaidDeadlineLabel({ ...unpaid, daysLeft: 1 })).toMatch(/\(dans 1 jour\)$/);
    expect(unpaidDeadlineLabel({ ...unpaid, daysLeft: 0 })).toMatch(/\(aujourd'hui\)$/);
    expect(unpaidDeadlineLabel({ deadlineAt: 'n/a', daysLeft: 3 })).toBe('');
  });
});

describe('restrictedWriteInfo (garde d’écriture, page des biens)', () => {
  it('impayé : message de régularisation avec la date limite, marqué impayé', () => {
    const info = restrictedWriteInfo({ trial: { status: 'converted' }, unpaid });
    expect(info.code).toBe('SUBSCRIPTION_REQUIRED');
    expect(info.unpaid).toEqual({ deadlineAt: unpaid.deadlineAt, daysLeft: 65 });
    expect(info.message).toMatch(/paiement a échoué/);
    expect(info.message).toMatch(/consultables, exportables et transmissibles/);
    expect(info.message).toMatch(/30 novembre 2026/);
  });

  it('essai expiré : message de fin d’essai, inchangé', () => {
    expect(restrictedWriteInfo({ trial: { status: 'expired' } })).toEqual({ code: 'TRIAL_EXPIRED', message: TRIAL_EXPIRED_MESSAGE });
  });

  it('autre restriction : abonnement nécessaire', () => {
    expect(restrictedWriteInfo({ trial: { status: 'none' } }).code).toBe('SUBSCRIPTION_REQUIRED');
    expect(restrictedWriteInfo(null).unpaid).toBeUndefined();
  });
});

describe('câblage des écrans', () => {
  it('le bandeau traite l’impayé AVANT les cas d’essai', () => {
    const src = read('src/components/subscription/TrialBanner.tsx');
    const unpaidAt = src.indexOf('if (isUnpaid(data))');
    expect(unpaidAt).toBeGreaterThan(0);
    expect(unpaidAt).toBeLessThan(src.indexOf('<span className="font-medium">Votre essai gratuit est terminé.</span>'));
    expect(unpaidAt).toBeLessThan(src.indexOf("if (trial.status === 'none' && trial.dejaConsomme"));
  });

  it('le message d’impayé propose le portail Stripe existant', () => {
    const notice = read('src/components/subscription/UnpaidPaymentNotice.tsx');
    expect(notice).toMatch(/openBillingPortal\(\)/);
    expect(read('src/lib/billing/open-billing-portal.ts')).toMatch(/\/api\/billing\/create-customer-portal-session/);
    const dialog = read('src/components/premium/WriteBlockedDialog.tsx');
    expect(dialog).toMatch(/const impaye = Boolean\(info\?\.unpaid\)/);
    expect(dialog).toMatch(/openBillingPortal\(\)/);
  });

  it('la garde d’écriture et la page des biens n’annoncent plus « essai terminé » à tout compte restreint', () => {
    expect(read('src/contexts/WriteGuardContext.tsx')).toMatch(/restrictedWriteInfo\(/);
    const assets = read('src/app/(dashboard)/assets/page.tsx');
    expect(assets).toMatch(/restrictedWriteInfo\(/);
    expect(assets).not.toMatch(/code: 'TRIAL_EXPIRED',\s*message:\s*\n?\s*"Votre essai gratuit est terminé/);
  });

  it('« Mon abonnement » et la page des offres distinguent l’impayé', () => {
    const summary = read('src/components/subscription/SubscriptionSummary.tsx');
    expect(summary).toMatch(/data\.isRestricted && !isUnpaid\(data\)/);
    const offres = read('src/app/(dashboard)/mon-compte/offres/page.tsx');
    expect(offres).toMatch(/setEssaiTermine\(isTrialOver\(data\)\)/);
    expect(offres).toMatch(/<UnpaidPaymentNotice/);
  });
});
