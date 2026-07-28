/**
 * Calcul des coûts — corrige le défaut n°10 du CDC Refonte §2.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PLUS AUCUN TARIF N'EST CODÉ EN DUR.
 *
 * L'ancien `COST_MICROS_PER_TOKEN` de `gemini-client.ts` était une constante du
 * code, et ne référençait aucun des modèles réellement appelés : tous les coûts
 * affichés en administration étaient calculés au tarif de repli, donc faux.
 *
 * Les tarifs proviennent désormais de la table `ai_model_pricing`, alimentée
 * par le lot `refresh-pricing.job.ts` depuis la grille du compte Google, et
 * saisissables en administration lorsque la source automatique ne couvre pas un
 * modèle. Conforme au CDC Assistant §15.9 : « les prix sont des données
 * d'exploitation, pas des règles fonctionnelles ».
 *
 * Le calcul reste synchrone : il lit un cache mémoire chargé au démarrage.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { listLlmOperations } from '../registry/operations';
import { getCachedPrice, getCacheState, loadPricingCache } from './pricing/pricing.repository';

const warnedModels = new Set<string>();

/**
 * Coût d'un appel, en micro-unités de devise. `null` si le modèle n'a pas de
 * tarif connu.
 *
 * ⚠️ CORRECTION D'UN DÉFAUT DE CONCEPTION. La première version LEVAIT en
 * l'absence de tarif. Conséquence : un appel modèle réussi, dont la sortie
 * était valide, était intégralement perdu parce que son coût n'était pas
 * calculable. Un défaut de mesure ne doit jamais détruire un résultat métier.
 *
 * La garantie « pas de mesure fausse » reste tenue, mais au bon endroit :
 * `assertPricingReady()` bloque le DÉMARRAGE en production si un modèle du
 * référentiel n'a pas de tarif. À l'exécution, un tarif manquant produit un
 * coût nul explicitement signalé, jamais un coût inventé.
 */
export function calcCostMicros(
  model: string,
  inputTokens: number,
  outputTokens: number,
  provider = 'gemini',
): number | null {
  const price = getCachedPrice(provider, model);
  if (!price) {
    const key = `${provider}/${model}`;
    if (!warnedModels.has(key)) {
      warnedModels.add(key);
      console.warn(
        `[ai-cost] Aucun tarif connu pour ${key} — coût non mesuré. ` +
        'Exécutez /api/cron/ai/refresh-model-pricing ou saisissez le tarif en administration.',
      );
    }
    return null;
  }
  return Math.round(inputTokens * price.inputMicros + outputTokens * price.outputMicros);
}

/** Modèles du référentiel dépourvus de tarif dans le cache. */
export function listModelsWithoutPricing(): string[] {
  const missing = new Set<string>();
  for (const op of listLlmOperations()) {
    for (const model of [op.primaryModel, ...op.fallbackModels]) {
      if (!getCachedPrice(op.provider, model)) missing.add(`${op.provider}/${model}`);
    }
  }
  return [...missing];
}

/** Modèles dont le tarif a été saisi manuellement sans confirmation. */
export function listUnverifiedPricing(): string[] {
  const unverified = new Set<string>();
  for (const op of listLlmOperations()) {
    for (const model of [op.primaryModel, ...op.fallbackModels]) {
      const price = getCachedPrice(op.provider, model);
      if (price && !price.verified) unverified.add(`${op.provider}/${model}`);
    }
  }
  return [...unverified];
}

/**
 * Contrôle de démarrage — CDC Assistant §15.14.
 *
 * En production, un tarif manquant empêche le démarrage. Hors production, un
 * avertissement suffit : les tests et le développement local n'ont pas à
 * dépendre de la disponibilité de l'API de facturation.
 */
export async function assertPricingReady(): Promise<void> {
  if (getCacheState().size === 0) await loadPricingCache();

  const missing = listModelsWithoutPricing();
  const unverified = listUnverifiedPricing();

  if (missing.length > 0) {
    const message = `[ai-cost] Modèles sans tarif : ${missing.join(', ')}.`;
    if (process.env.NODE_ENV === 'production') throw new Error(message);
    console.warn(`${message} — coûts non calculables hors production.`);
  }

  if (unverified.length > 0) {
    console.warn(`[ai-cost] ⚠️ Tarifs saisis manuellement non confirmés : ${unverified.join(', ')}`);
  }
}

export { loadPricingCache, getCachedPrice } from './pricing/pricing.repository';
export type { ModelPrice } from './pricing/pricing-source.port';
