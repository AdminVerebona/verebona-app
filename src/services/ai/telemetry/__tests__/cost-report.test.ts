/**
 * CDC BO IA SCR-09 — mesure des coûts.
 *
 * Deux règles de l'écran Coûts décident de la confiance qu'on peut accorder aux
 * chiffres affichés : « tarif manquant : afficher coût non calculable plutôt
 * qu'un fallback tarifaire silencieux », et « signaler l'incomplétude ».
 *
 * La moyenne est l'endroit où ces règles se trahissent le plus discrètement.
 */
import { describe, it, expect } from 'vitest';
import { averageCostPerCall } from '../cost-report.repository';

const totals = (over: Partial<Parameters<typeof averageCostPerCall>[0]> = {}) => ({
  functionalMicros: 1_000_000,
  technicalMicros: 0,
  calls: 10,
  failedCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  unpricedCalls: 0,
  ...over,
});

describe('coût moyen par appel', () => {
  it('divise par les appels tarifés', () => {
    expect(averageCostPerCall(totals())).toBe(100_000);
  });

  it("n'inclut pas les appels sans tarif dans le diviseur", () => {
    // Les inclure ferait baisser la moyenne à chaque tarif manquant, et
    // donnerait l'illusion d'une économie là où il y a un trou de mesure.
    expect(averageCostPerCall(totals({ unpricedCalls: 5 }))).toBe(200_000);
  });

  it('additionne fonctionnel et technique', () => {
    // Les sondes coûtent : les exclure de la moyenne masquerait le prix d'une
    // panne longue.
    expect(averageCostPerCall(totals({ technicalMicros: 1_000_000 }))).toBe(200_000);
  });

  it("rend null quand aucun appel n'est tarifé", () => {
    // Zéro serait un chiffre, et un chiffre est cru. `null` dit qu'on ne sait pas.
    expect(averageCostPerCall(totals({ calls: 3, unpricedCalls: 3 }))).toBeNull();
    expect(averageCostPerCall(totals({ calls: 0, unpricedCalls: 0 }))).toBeNull();
  });
});
