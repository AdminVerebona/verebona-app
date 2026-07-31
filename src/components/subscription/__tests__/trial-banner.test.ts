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
});
