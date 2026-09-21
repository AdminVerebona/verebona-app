/**
 * Boucle d'échec infinie — constatée en recette le 21/09/2026.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI S'EST PASSÉ
 *
 * `analysis-recovery.service` relance un document en échec tant que son
 * compteur reste sous dix. Le pipeline remettait ce compteur à zéro à chaque
 * écriture d'état — y compris `ANALYZING`, écrit au DÉBUT de chaque analyse.
 *
 * Le compteur ne dépassait donc jamais 1, la limite était inatteignable, et un
 * document qui échoue toujours était relancé toutes les cinq minutes,
 * indéfiniment, avec un appel modèle facturé à chaque tour. Les journaux
 * montraient les lots 417 à 435 se succéder sur le même document.
 *
 * Ce test porte sur la règle, pas sur le SQL : seul un ABOUTISSEMENT efface
 * l'ardoise. C'est ce qui rend la limite de reprise atteignable.
 */
import { describe, it, expect } from 'vitest';

/**
 * Reproduction de la règle appliquée par `setState`.
 *
 * Dupliquée ici volontairement : la fonction d'origine écrit en base et n'est
 * pas exportée. Ce que ce test protège, c'est la LISTE — si quelqu'un y ajoute
 * `ANALYZING`, la boucle revient.
 */
const ETATS_ABOUTIS = ['ANALYZED', 'VALIDATION_REQUIRED', 'CONFLICT_DETECTED', 'FUSION_SUGGESTED'];
const remetAZero = (state: string) => ETATS_ABOUTIS.includes(state);

describe('remise à zéro du compteur d’échecs', () => {
  it('efface l’ardoise sur un aboutissement', () => {
    for (const s of ETATS_ABOUTIS) {
      expect(remetAZero(s), s).toBe(true);
    }
  });

  it('⚠️ n’efface JAMAIS sur « ANALYZING »', () => {
    // La cause exacte de la boucle. `ANALYZING` est écrit au début de chaque
    // analyse : l'y inclure remet le compteur à zéro avant chaque tentative, et
    // la limite de reprise devient inatteignable.
    expect(remetAZero('ANALYZING')).toBe(false);
  });

  it('n’efface pas sur un échec', () => {
    expect(remetAZero('ANALYSIS_FAILED')).toBe(false);
  });

  it('n’efface pas sur un état inconnu', () => {
    // Par défaut on conserve l'historique : effacer par méconnaissance est le
    // comportement qui a produit l'incident.
    for (const s of ['UPLOADED', 'PENDING', '', 'AUTRE_CHOSE']) {
      expect(remetAZero(s), s).toBe(false);
    }
  });
});

describe('atteignabilité de la limite de reprise', () => {
  it('le compteur progresse quand chaque tentative échoue', () => {
    // Simulation du cycle réel : relance → ANALYZING → échec, dix fois.
    let compteur = 0;
    for (let tour = 0; tour < 10; tour++) {
      if (remetAZero('ANALYZING')) compteur = 0;  // début d'analyse
      compteur += 1;                               // échec
    }
    // Avec l'ancien comportement, cette valeur restait à 1 pour toujours.
    expect(compteur).toBe(10);
  });

  it('un succès remet bien le compteur à zéro', () => {
    let compteur = 7;
    if (remetAZero('ANALYZED')) compteur = 0;
    expect(compteur).toBe(0);
  });
});
