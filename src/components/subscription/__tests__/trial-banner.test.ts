/**
 * Bandeau d'essai — CDC 1 §9.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN MESSAGE FAUX EST PIRE QU'UN MESSAGE ABSENT
 *
 * Le bandeau annonçait « Votre essai gratuit est terminé » dès que le compte
 * était restreint — y compris sur un compte créé la minute précédente, dont
 * l'essai n'avait pas pu être attribué.
 *
 * L'utilisateur venait de s'inscrire pour sept jours et apprenait que
 * c'était fini. Rien dans le code ne signalait l'anomalie : le bandeau
 * fonctionnait parfaitement, il mentait.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { libelleEssai } from '../trial-label';

const SOURCE = readFileSync(
  join(process.cwd(), 'src/components/subscription/TrialBanner.tsx'),
  'utf-8',
);

describe('les trois états restreints sont distingués', () => {
  it('traite « jamais ouvert » avant « terminé »', () => {
    // L'ordre compte : `isRestricted` seul attraperait le cas neuf si la
    // condition générale venait en premier.
    const posNone = SOURCE.indexOf("trial.status === 'none'");
    const posExpired = SOURCE.indexOf("trial.status === 'expired'");
    expect(posNone).toBeGreaterThan(-1);
    expect(posNone).toBeLessThan(posExpired);
  });

  it('n’annonce pas une fin d’essai sur un essai jamais ouvert', () => {
    const bloc = SOURCE.slice(
      SOURCE.indexOf("trial.status === 'none'"),
      SOURCE.indexOf("trial.status === 'expired'"),
    );
    expect(bloc).not.toContain('est terminé');
    expect(bloc).toContain("n&apos;a pas pu être activé");
  });

  it('conserve le message d’origine pour un essai réellement expiré', () => {
    expect(SOURCE).toContain('Votre essai gratuit est terminé.');
  });

  it('oriente vers les offres, pas vers l’écran de fin d’essai', () => {
    // `/abonnement/essai-termine` raconterait la même histoire fausse.
    const bloc = SOURCE.slice(
      SOURCE.indexOf("trial.status === 'none'"),
      SOURCE.indexOf("trial.status === 'expired'"),
    );
    expect(bloc).toContain('/mon-compte/offres');
    expect(bloc).not.toContain('essai-termine');
  });

  it('aucun bouton ne pointe vers la page supprimée', () => {
    // Elle ne fait plus que rediriger : y envoyer coûterait un aller-retour
    // serveur, et laisserait croire que deux écrans coexistent encore.
    expect(SOURCE).not.toContain('/abonnement/essai-termine');
  });
});

describe('la page de fin d’essai ne fait plus que rediriger', () => {
  const PAGE = readFileSync(
    join(process.cwd(), 'src/app/abonnement/essai-termine/page.tsx'),
    'utf-8',
  );

  it('elle ne rend plus de grille tarifaire', () => {
    // Deux grilles maintenues séparément divergent : celle-ci ignorait déjà
    // le parrainage et la programmation de changement d'offre.
    expect(PAGE).not.toMatch(/create-checkout-session/);
    expect(PAGE).not.toMatch(/Choisir Premium/);
  });

  it('elle redirige de façon permanente', () => {
    // Un 307 ferait repasser navigateurs et moteurs par ici indéfiniment.
    expect(PAGE).toContain('permanentRedirect');
  });
});

describe('libellé de l’essai en cours', () => {
  it('dit « gratuit », pas « Premium »', () => {
    // Ce qui rassure pendant un essai, c'est qu'il ne coûte rien. Le niveau
    // de fonctionnalités se lit dans la comparaison des offres.
    expect(libelleEssai(7)).toBe('Essai gratuit en cours — 7 jours restants');
  });

  it('accorde le singulier', () => {
    // Un « 1 jours restants » se remarque, et fait douter du reste de l'écran.
    expect(libelleEssai(1)).toBe('Essai gratuit en cours — 1 jour restant');
  });

  it('les deux écrans emploient la même fonction', () => {
    // Deux phrases identiques écrites séparément finissent par diverger :
    // ce projet en a déjà fait les frais avec les pages d'offres.
    for (const chemin of [
      'src/components/subscription/TrialBanner.tsx',
      'src/components/subscription/SubscriptionSummary.tsx',
    ]) {
      const source = readFileSync(join(process.cwd(), chemin), 'utf-8');
      expect(source, chemin).toContain('libelleEssai(trial.daysRemaining)');
      // Plus aucune phrase rédigée à la main.
      expect(source, chemin).not.toMatch(/Essai Premium — \{/);
    }
  });
});
