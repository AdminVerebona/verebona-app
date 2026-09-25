/**
 * Mon compte : un seul bloc d'abonnement (« Mon abonnement »).
 * « Abonnement » (InformationsTab) est supprimé ; ses éléments propres sont
 * repris dans SubscriptionSummary.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const summary = read('src/components/subscription/SubscriptionSummary.tsx');
const infos = read('src/app/(dashboard)/mon-compte/informations/InformationsTab.tsx');

describe('bloc « Mon abonnement »', () => {
  it('un seul bouton pour les factures et les moyens de paiement', () => {
    expect(summary).toContain('Factures et moyens de paiement');
    expect(summary).not.toMatch(/>\s*Mes factures\s*</);
    expect(summary).not.toMatch(/>\s*Moyen de paiement\s*</);
    expect(summary).not.toContain("push('/mon-compte/offres#resiliation')");
  });

  it('propose « Changer d’offre », le bloc Duo et le parrainage', () => {
    expect(summary).toContain('Changer d&apos;offre');
    expect(summary).toContain('2e utilisateur — Offre Duo');
    expect(summary).toContain('<DuoInvitationPanel />');
    expect(summary).toContain('<ReferralBlock />');
  });

  it('les actions restent accessibles si l’état de l’abonnement ne se charge pas', () => {
    expect(summary).not.toContain('if (loading || !data) return null;');
    const sansDonnees = summary.slice(summary.indexOf('if (!data) {'), summary.indexOf('const { trial, subscription, quotas } = data;'));
    expect(sansDonnees).toContain('{actions}');
  });
});

describe('ancien bloc « Abonnement »', () => {
  it('n’existe plus dans InformationsTab', () => {
    expect(infos).not.toMatch(/<CardTitle[^>]*>\s*Abonnement\s*<\/CardTitle>/);
    expect(infos).not.toContain('<ReferralBlock');
    expect(infos).not.toContain('<DuoInvitationPanel');
  });
});
