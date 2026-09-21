/**
 * CDC BO IA §18.2 — « aucune grille tarifaire codée en dur concurrente ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT QUE CE TEST EMPÊCHE DE REVENIR
 *
 * Le dépôt porte DEUX listes de tarifs : celle de la passerelle
 * (`gemini-public-catalog`) et celle du seed. Le 18/09/2026, le modèle par
 * défaut de l'assistant est passé à `gemini-3.5-flash-lite` — présent dans la
 * première, absent de la seconde.
 *
 * Conséquence : le contrôle tarifaire a refusé le démarrage de la
 * préproduction, et le seed censé le réparer ne contenait pas le modèle
 * manquant. Deux listes cohérentes chacune avec elle-même, et incohérentes
 * entre elles — exactement le défaut que nous avions déjà rencontré le matin
 * même entre un prompt et son schéma.
 *
 * Tant que la seconde liste existe, ce test garde les deux d'accord.
 */
import { describe, it, expect } from 'vitest';
import { PUBLIC_PRICES } from '../ai-model-pricing.seed';
import { GEMINI_PUBLIC_CATALOG } from '@/services/ai/gateway/pricing/gemini-public-catalog';
import { AI_OPERATIONS } from '@/services/ai/registry/operations';

/** Modèles que l'application appelle réellement. */
function modelesDuReferentiel(): Set<string> {
  const out = new Set<string>();
  for (const op of Object.values(AI_OPERATIONS)) {
    if (op.provider === 'none') continue;
    out.add(op.primaryModel);
    for (const f of op.fallbackModels) out.add(f);
  }
  return out;
}

describe('les deux grilles tarifaires restent d’accord', () => {
  it('le seed couvre tout modèle du référentiel', () => {
    // C'est la garantie qui manquait : sans elle, un changement de modèle rend
    // le démarrage impossible et le seed inopérant.
    const seed = new Set(PUBLIC_PRICES.map((p) => p.model));
    for (const m of modelesDuReferentiel()) {
      expect(seed.has(m), `${m} absent du seed tarifaire`).toBe(true);
    }
  });

  it('la passerelle couvre tout modèle du référentiel', () => {
    const catalogue = new Set(GEMINI_PUBLIC_CATALOG.map((e) => e.model));
    for (const m of modelesDuReferentiel()) {
      expect(catalogue.has(m), `${m} absent du catalogue de la passerelle`).toBe(true);
    }
  });

  it('annonce les mêmes prix des deux côtés', () => {
    // Deux prix divergents produiraient deux coûts différents selon le chemin
    // d'écriture — et personne ne saurait lequel croire.
    for (const p of PUBLIC_PRICES) {
      const entry = GEMINI_PUBLIC_CATALOG.find((e) => e.model === p.model);
      if (!entry) continue;
      expect(p.inputPerMillion, `${p.model} entrée`).toBe(entry.inputPerMillion);
      expect(p.outputPerMillion, `${p.model} sortie`).toBe(entry.outputPerMillion);
    }
  });
});
