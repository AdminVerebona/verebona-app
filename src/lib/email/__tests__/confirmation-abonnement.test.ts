/**
 * Souscription : UN seul email de confirmation, avec la prochaine échéance.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../email-service', () => ({ emailService: { send: async () => ({ success: true }) } }));
vi.mock('@/db', () => ({ db: {} }));

// Lot 81E : la confirmation n'est plus envoyée « fire and forget » — ses
// variables sont construites (pures) par la file durable des e-mails
// transactionnels (type PREMIUM_CONFIRMATION).
const { premiumConfirmationVariables } = await import('../billing-emails');
const { getCatalogEntry } = await import('@/lib/notifications/catalog');
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('email « Confirmation de votre abonnement Verebona Premium »', () => {
  it('renseigne {{nextBillingDate}} (la prochaine échéance partait vide)', () => {
    const v = premiumConfirmationVariables('Anne', new Date('2027-04-06T23:30:00Z'));
    expect(v.nextBillingDate).toBe('7 avril 2027');
    expect(v.premiumUntil).toBe('7 avril 2027');
  });

  it('gabarit : nouveau texte, sans bascule Standard ni bouton « Gérer mon abonnement »', () => {
    // Lot 66C : les corps HTML de l'amorçage et des défauts vivent dans le module partagé
    // `lib/email/email-html-templates.ts` (charte 2026), référencé par ces deux fichiers.
    expect(read('src/db/seeds/email_templates_system.ts')).toContain('body: PREMIUM_CONFIRMATION_HTML,');
    expect(read('src/lib/email-defaults.ts')).toContain('body: PREMIUM_CONFIRMATION_DEFAULT_HTML,');
    const mod = read('src/lib/email/email-html-templates.ts');
    for (const [debut, fin] of [['export const PREMIUM_CONFIRMATION_HTML', 'export const PREMIUM_CONFIRMATION_DEFAULT_HTML'], ['export const PREMIUM_CONFIRMATION_DEFAULT_HTML', 'export const TRIAL_CONFIRMATION_DEFAULT_HTML']]) {
      const tpl = mod.slice(mod.indexOf(debut), mod.indexOf(fin));
      expect(tpl).toContain('Vous pouvez gérer ou résilier votre abonnement à tout moment depuis votre compte.');
      expect(tpl).not.toContain('portail Stripe');
      expect(tpl).not.toContain('À défaut de renouvellement');
      expect(tpl).not.toContain('manageSubscriptionUrl');
      expect(tpl).not.toContain('Gérer mon abonnement');
    }
    expect(read('src/db/migrations/0140_subscription_confirmation_email.sql')).toContain("upper(type) = 'PREMIUM_CONFIRMATION'");
  });
});

describe('email « Votre abonnement Verebona » (notification) — lot 81E', () => {
  it('omis SEULEMENT quand la confirmation de la même opération est enregistrée durablement', () => {
    for (const type of ['SUBSCRIPTION_ACTIVATED', 'SUBSCRIPTION_CHANGED']) {
      const entry = getCatalogEntry(type)!;
      const avec = entry.render({ planCode: 'PREMIUM', planLabel: 'Premium', direction: 'upgrade', confirmationJobId: 42 } as never);
      const sans = entry.render({ planCode: 'STANDARD', planLabel: 'Standard', direction: 'downgrade' } as never);
      // Ancien drapeau posé AVANT l'envoi (simple intention) : plus une preuve.
      const intention = entry.render({ planCode: 'PREMIUM', planLabel: 'Premium', direction: 'upgrade', confirmationEmailSent: true } as never);
      expect(avec.emailTemplateCode).toBeUndefined();
      expect(avec.emailSkipReason).toBe('covered_by_contract_confirmation:42');
      expect(sans.emailTemplateCode).toBe('notif_subscription');
      expect(intention.emailTemplateCode).toBe('notif_subscription');
      // La cloche reste renseignée.
      expect(avec.bellBody).toContain('Premium');
    }
  });

  it('la synchronisation décide par opération (plus d’envoi détaché ni de drapeau avant envoi)', () => {
    const sync = read('src/services/billing/subscription-sync.service.ts');
    expect(sync).toContain('recordSubscriptionTransition(tx, {');
    expect(sync).not.toContain('sendPremiumConfirmationEmail');
    expect(sync).not.toContain('confirmationEmailSent');
  });
});
