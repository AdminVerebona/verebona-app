/**
 * CDC §10.4, critères n°15 et n°16 — sortie des moteurs de recherche historiques.
 *
 * « La recherche sémantique et la réponse générative sont remplacées par un
 *   assistant unique et sourcé » (n°15), et « aucune ancienne route de recherche
 *   IA n'est encore appelée par l'interface » (n°16).
 *
 * Deux moteurs historiques répondaient aux mêmes questions que l'assistant :
 *   · `intelligentSearch` derrière `/api/search/intelligent` — usage n°7 ;
 *   · `geminiSearch` en repli de `/api/search` — usage n°6.
 *
 * Aucun des deux ne lisait `AI_INTELLIGENT_ASSISTANT`. Basculer le drapeau
 * faisait donc coexister trois moteurs de réponse, ce que le §10.4 interdit.
 *
 * Ces tests portent sur la DÉCISION d'aiguillage, pas sur les routes elles-mêmes :
 * `shouldRunLegacy` est la fonction que les deux routes consultent désormais, et
 * c'est son comportement qui fait la conformité.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  shouldRunLegacy, shouldRunNewEngine, getFlagMode, assertFlagModesSupported,
} from '../ai-feature-flags';

const FLAG = 'AI_INTELLIGENT_ASSISTANT' as const;
const initial = process.env[FLAG];

beforeEach(() => { delete process.env[FLAG]; });
afterEach(() => {
  if (initial === undefined) delete process.env[FLAG];
  else process.env[FLAG] = initial;
});

describe('les moteurs de recherche historiques suivent le drapeau de l’assistant', () => {
  it('reste ouvert tant que le drapeau vaut legacy', () => {
    process.env[FLAG] = 'legacy';
    // Avant bascule, l'ancien chemin est le seul : le couper priverait les
    // comptes éligibles de recherche sémantique sans rien mettre à la place.
    expect(shouldRunLegacy(FLAG)).toBe(true);
    expect(shouldRunNewEngine(FLAG)).toBe(false);
  });

  it('se ferme dès que le drapeau est basculé', () => {
    process.env[FLAG] = 'enabled';
    expect(shouldRunLegacy(FLAG)).toBe(false);
    expect(shouldRunNewEngine(FLAG)).toBe(true);
  });

  it("refuse le mode observation au démarrage plutôt que de faire répondre deux moteurs", () => {
    // Piège découvert en écrivant ces tests : `shouldRunLegacy` laisse l'ancien
    // moteur en service tant que le mode n'est pas `enabled`, tandis que
    // `isUseCaseRunning` démarre le nouveau dès `shadow`. Le mode `shadow`
    // ferait donc répondre l'assistant ET la recherche historique aux mêmes
    // questions — le §10.4 en creux.
    //
    // Le §10.2 suppose une décision qu'on peut retenir. Une réponse d'assistant
    // n'en est pas une : l'afficher, c'est l'appliquer.
    process.env[FLAG] = 'shadow';
    expect(() => assertFlagModesSupported()).toThrow(/shadow/i);
  });

  it('reste ouvert par défaut, drapeau absent', () => {
    // Un déploiement sans variable ne doit pas éteindre silencieusement la
    // recherche : l'absence vaut `legacy`.
    expect(getFlagMode(FLAG)).toBe('legacy');
    expect(shouldRunLegacy(FLAG)).toBe(true);
  });

  it('ne laisse jamais les deux chemins ouverts en même temps (§10.4)', () => {
    // Sur les seuls modes que ce drapeau accepte — `shadow` étant refusé au
    // démarrage, il ne peut pas atteindre l'exécution.
    for (const mode of ['legacy', 'enabled']) {
      process.env[FLAG] = mode;
      expect(shouldRunLegacy(FLAG) && shouldRunNewEngine(FLAG)).toBe(false);
    }
  });

  it("laisse passer les modes supportés", () => {
    for (const mode of ['legacy', 'enabled']) {
      process.env[FLAG] = mode;
      expect(() => assertFlagModesSupported()).not.toThrow();
    }
  });

  it("n'entrave pas le mode observation des autres usages", () => {
    // La réconciliation, elle, décide sans écrire : son mode observation est
    // le cœur du §10.2 et ne doit pas être emporté par cette restriction.
    process.env.AI_RECONCILIATION_ENGINE = 'shadow';
    process.env[FLAG] = 'legacy';
    expect(() => assertFlagModesSupported()).not.toThrow();
  });
});
