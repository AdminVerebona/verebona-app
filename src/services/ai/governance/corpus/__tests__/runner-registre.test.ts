/**
 * Harnais de mesure — cohérence avec le registre d'opérations.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE MODE `dry` NE VOYAIT PAS LE DÉFAUT
 *
 * Le runner réel employait `SOURCE_ANALYSIS_EXTRACT`, code qui n'existe pas :
 * le registre déclare `extract_source`. Les 28 cas ont échoué avant le
 * moindre appel.
 *
 * La vérification à blanc avait pourtant rendu « 28 sur 28 » — elle ne passe
 * pas par la passerelle, donc jamais par le registre. Ce test comble l'angle
 * mort sans dépenser un appel.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const RUNNER = read('src/services/ai/governance/corpus/analysis-runner.ts');
const OPERATIONS = read('src/services/ai/registry/operations.ts');
const ROUTE = read('src/app/api/cron/ai/corpus-run/route.ts');

/** Codes réellement déclarés au registre. */
const DECLARES = [...OPERATIONS.matchAll(/operationCode: '([a-z_]+)'/g)].map((m) => m[1]);

describe('le harnais n’emploie que des opérations déclarées', () => {
  it('le code par défaut existe au registre', () => {
    const m = RUNNER.match(/operationCode = '([A-Za-z_]+)'/);
    expect(m).not.toBeNull();
    expect(DECLARES).toContain(m![1]);
  });

  it('aucun code en majuscules ne subsiste', () => {
    // Les codes du registre sont en minuscules. Un identifiant en majuscules
    // trahit un nom inventé.
    const majuscules = [...RUNNER.matchAll(/operationCode[:=]\s*'([A-Z_]+)'/g)];
    expect(majuscules).toHaveLength(0);
  });
});

describe('une référence vide n’écrase jamais la précédente', () => {
  it('la campagne refuse d’enregistrer sans cas mesuré', () => {
    // Une référence de 0 cas ferait conclure à une amélioration totale lors
    // de la comparaison suivante.
    expect(ROUTE).toMatch(/run\.summary\.total === 0/);
    expect(ROUTE).toContain('refusReference');
  });

  it('elle refuse aussi quand les erreurs dominent', () => {
    expect(ROUTE).toMatch(/run\.errors\.length > run\.summary\.total/);
  });

  it('le refus est motivé, pas silencieux', () => {
    expect(ROUTE).toMatch(/référence non\s*\` \+\s*'enregistrée|référence non /);
  });
});

describe('le verdict refuse de conclure sans mesure', () => {
  // ══════════════════════════════════════════════════════════════════════
  // LE SILENCE A ÉTÉ LU COMME UNE APPROBATION
  //
  // `isSafeToSwitch` a rendu `safe: true` en comparant une vérification à
  // blanc à une référence de zéro cas. Aucune régression n'était détectable
  // — il n'y avait rien à comparer.
  //
  // En l'absence de mesure, la réponse doit être « on ne sait pas ».
  // ══════════════════════════════════════════════════════════════════════
  const RUNNER_SRC = read('src/services/ai/governance/corpus/corpus-runner.ts');

  it('refuse une référence vide', () => {
    expect(RUNNER_SRC).toMatch(/before\.summary\.total === 0/);
  });

  it('refuse une campagne courante vide', () => {
    expect(RUNNER_SRC).toMatch(/after\.summary\.total === 0/);
  });

  it('refuse de comparer une simulation à une mesure', () => {
    // Une vérification à blanc compare les résultats attendus à eux-mêmes.
    expect(RUNNER_SRC).toMatch(/à blanc/);
  });

  it('ces refus précèdent la détection de régressions', () => {
    // Borné à `isSafeToSwitch` : `detectRegressions` est aussi appelé plus
    // haut dans le fichier, par une autre fonction. Chercher sa première
    // occurrence comparerait deux positions sans rapport.
    const bloc = RUNNER_SRC.slice(RUNNER_SRC.indexOf('export function isSafeToSwitch'));
    const posGarde = bloc.indexOf('before.summary.total === 0');
    const posDetect = bloc.indexOf('const regressions = detectRegressions');
    expect(posGarde).toBeGreaterThan(-1);
    expect(posGarde).toBeLessThan(posDetect);
  });
});
