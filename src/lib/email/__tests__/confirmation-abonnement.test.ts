/**
 * Souscription : UN seul email de confirmation, avec la prochaine échéance.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const sent: Array<{ templateCode: string; variables: Record<string, string> }> = [];
vi.mock('../email-service', () => ({
  emailService: { send: async (m: { templateCode: string; variables: Record<string, string> }) => { sent.push(m); return { success: true }; } },
}));
vi.mock('@/db', () => {
  const chain = { select: () => chain, from: () => chain, where: () => chain, limit: async () => [{ id: 3, email: 'a@b.fr', firstName: 'Anne' }] };
  return { db: chain };
});

const { sendPremiumConfirmationEmail } = await import('../billing-emails');
const { getCatalogEntry } = await import('@/lib/notifications/catalog');
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('email « Confirmation de votre abonnement Verebona Premium »', () => {
  it('renseigne {{nextBillingDate}} (la prochaine échéance partait vide)', async () => {
    await sendPremiumConfirmationEmail(3, new Date('2027-04-06T23:30:00Z'));
    expect(sent[0].templateCode).toBe('PREMIUM_CONFIRMATION');
    expect(sent[0].variables.nextBillingDate).toBe('7 avril 2027');
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

describe('email « Votre abonnement Verebona » (notification)', () => {
  it('non envoyé quand l’email de confirmation part déjà', () => {
    for (const type of ['SUBSCRIPTION_ACTIVATED', 'SUBSCRIPTION_CHANGED']) {
      const entry = getCatalogEntry(type)!;
      const avec = entry.render({ planCode: 'PREMIUM', planLabel: 'Premium', direction: 'upgrade', confirmationEmailSent: true } as never);
      const sans = entry.render({ planCode: 'STANDARD', planLabel: 'Standard', direction: 'downgrade' } as never);
      expect(avec.emailTemplateCode).toBeUndefined();
      expect(sans.emailTemplateCode).toBe('notif_subscription');
      // La cloche reste renseignée.
      expect(avec.bellBody).toContain('Premium');
    }
  });

  it('la synchronisation transmet le signal à la notification', () => {
    const sync = read('src/services/billing/subscription-sync.service.ts');
    expect(sync).toContain('notifierChangementDeStatut(result, { confirmationEmailSent: confirmationEmail })');
  });
});
