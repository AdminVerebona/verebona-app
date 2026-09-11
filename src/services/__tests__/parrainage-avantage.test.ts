/**
 * Avantage de parrainage — le parrain seul.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE PROMESSE NON TENUE NE PRODUIT AUCUNE ERREUR
 *
 * Changer la règle métier sans changer les textes laisserait l'application
 * fonctionner parfaitement — en annonçant au filleul un mois offert qu'il ne
 * recevrait jamais.
 *
 * Trois endroits le promettaient : deux sur l'écran d'inscription, et un dans
 * l'email d'invitation — celui-ci envoyé nominativement à un tiers, ce qui en
 * fait un engagement écrit.
 *
 * Ces tests lient la règle et ce qui est dit d'elle.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

/** Le code seul : un commentaire expliquant l'ancienne règle n'est pas la règle. */
const sansCommentaires = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

const CRON = sansCommentaires(read('src/app/api/cron/referral-rewards/route.ts'));
const SIGNUP = sansCommentaires(read('src/app/(auth)/signup/page.tsx'));
const INVITATION = sansCommentaires(read('src/app/api/referral/send-email/route.ts'));

describe('la règle : le parrain seul est récompensé', () => {
  it('l’avantage n’est accordé qu’au compte du parrain', () => {
    expect(CRON).toMatch(/postponeNextBillingByOneMonth\(\s*event\.referrerAccountId/);
  });

  it('le compte du filleul ne reçoit rien', () => {
    expect(CRON).not.toMatch(/postponeNextBillingByOneMonth\([^)]*referredAccountId/);
  });

  it('l’échec pour le parrain suffit à écarter l’événement', () => {
    // Aucune raison de marquer « accordé » si le seul bénéficiaire n'a rien eu.
    expect(CRON).toMatch(/if \(!referrer\.granted\)/);
  });

  it('le déclencheur reste l’abonnement annuel du filleul', () => {
    expect(CRON).toMatch(/billingPeriod !== 'yearly'/);
  });
});

describe('rien ne promet plus un avantage au filleul', () => {
  it('l’écran d’inscription n’annonce pas de mois offert au lecteur', () => {
    // « Profitez d'un mois offert » s'adressait à celui qui saisit le code.
    expect(SIGNUP).not.toMatch(/[Pp]rofitez d.un mois/);
    expect(SIGNUP).not.toMatch(/Un mois offert grâce au parrainage/);
  });

  it('l’écran d’inscription désigne le parrain comme bénéficiaire', () => {
    expect(SIGNUP).toMatch(/parrain bénéficiera/);
  });

  it('l’email d’invitation ne promet plus trois mois', () => {
    // Promesse écrite, envoyée nominativement à un tiers.
    expect(INVITATION).not.toMatch(/3 mois/);
  });

  it('l’email d’invitation nomme le parrain comme bénéficiaire', () => {
    expect(INVITATION).toMatch(/bénéficiera d'un mois offert/);
  });
});

describe('le bloc « Mon compte » annonce la bonne récompense', () => {
  // ══════════════════════════════════════════════════════════════════════
  // « 10 ANALYSES IA » ÉTAIT L'ANCIENNE RÈGLE
  //
  // Le compteur calculait encore `validatedCount * 10`, une unité qui
  // n'existe plus : la récompense diffère la prochaine échéance d'un mois.
  //
  // C'est le cinquième endroit qui portait une version périmée de cette
  // règle, après le cron, l'écran d'inscription, l'email d'invitation, la
  // vitrine et la page des offres.
  // ══════════════════════════════════════════════════════════════════════
  const BLOC = sansCommentaires(read('src/components/account/ReferralBlock.tsx'));
  const API = sansCommentaires(read('src/app/api/referral/me/route.ts'));

  it('plus aucune mention d’analyses IA ni de crédits', () => {
    expect(BLOC).not.toMatch(/analyses IA/);
    expect(BLOC).not.toMatch(/crédits/);
    expect(API).not.toMatch(/creditsEarned/);
  });

  it('la récompense est un mois d’abonnement', () => {
    expect(BLOC).toMatch(/1 mois d&apos;abonnement/);
  });

  it('le rapport est explicite, pas sous-entendu', () => {
    // Si la règle passe un jour à deux mois, c'est ici que ça se change.
    expect(API).toMatch(/MOIS_PAR_PARRAINAGE = 1/);
    expect(API).toMatch(/validatedCount \* MOIS_PAR_PARRAINAGE/);
  });

  it('l’éligibilité annoncée mentionne les offres annuelles', () => {
    expect(BLOC).toMatch(/Premium ou Premium Duo annuelles/);
  });
});
