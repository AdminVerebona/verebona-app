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

  it('propose « Changer d’offre » et le bloc Duo', () => {
    expect(summary).toContain('Changer d&apos;offre');
    expect(summary).toContain('2e utilisateur — Offre Duo');
    expect(summary).toContain('<DuoInvitationPanel />');
  });

  it('lot 26 — AC7 : le parrainage a sa propre carte, hors de « Mon abonnement »', () => {
    expect(summary).not.toContain('<ReferralBlock');
    const page = read('src/app/(dashboard)/mon-compte/page.tsx');
    expect(page).toContain('<ReferralCard />');
    const carte = read('src/components/account/ReferralCard.tsx');
    expect(carte).toContain('<CollapsibleCard');
    expect(carte).toContain('title="Parrainage"');
    expect(carte).toContain('<ReferralBlock withHeading={false} />');
    // Membre invité d'un compte Duo : pas de parrainage, comme avant.
    expect(carte).toContain("user.duoRole === 'MEMBER'");
  });

  it('lot 26 — AC7 : « Espace de stockage » sous « Documents », même barre ; plus de carte séparée', () => {
    const docs = summary.indexOf('<QuotaBar label="Documents"');
    const sto = summary.indexOf('<QuotaBar label="Espace de stockage"');
    expect(docs).toBeGreaterThan(-1);
    expect(sto).toBeGreaterThan(docs);
    const page = read('src/app/(dashboard)/mon-compte/page.tsx');
    expect(page).not.toContain('StorageUsageCard');
    expect(() => read('src/components/account/StorageUsageCard.tsx')).toThrow();
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
