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
import { isUseCaseRunning, listRunningUseCases } from '../flags/use-case-flags';
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

export interface PricingScope {
  /**
   * Ne considérer que les usages dont le drapeau vaut `enabled` ou `shadow`.
   *
   * Par défaut `false` : l'administration affiche l'état complet du référentiel,
   * y compris les usages non encore basculés, pour que le tarif puisse être
   * saisi *avant* la bascule et non pendant.
   */
  runningOnly?: boolean;
}

/** Modèles du référentiel dépourvus de tarif dans le cache. */
export function listModelsWithoutPricing({ runningOnly = false }: PricingScope = {}): string[] {
  const missing = new Set<string>();
  for (const op of listLlmOperations()) {
    if (runningOnly && !isUseCaseRunning(op.useCaseCode)) continue;
    for (const model of [op.primaryModel, ...op.fallbackModels]) {
      if (!getCachedPrice(op.provider, model)) missing.add(`${op.provider}/${model}`);
    }
  }
  return [...missing];
}

/** Modèles dont le tarif a été saisi manuellement sans confirmation. */
export function listUnverifiedPricing({ runningOnly = false }: PricingScope = {}): string[] {
  const unverified = new Set<string>();
  for (const op of listLlmOperations()) {
    if (runningOnly && !isUseCaseRunning(op.useCaseCode)) continue;
    for (const model of [op.primaryModel, ...op.fallbackModels]) {
      const price = getCachedPrice(op.provider, model);
      if (price && !price.verified) unverified.add(`${op.provider}/${model}`);
    }
  }
  return [...unverified];
}

export interface PricingReadiness {
  /** Usages dont le nouveau moteur s'exécute (`enabled` ou `shadow`). */
  runningUseCases: string[];
  /** Tarifs manquants sur le périmètre réellement actif — seuls bloquants. */
  missingForRunning: string[];
  /** Tarifs manquants sur l'ensemble du référentiel — informatif. */
  missingOverall: string[];
  unverified: string[];
  cacheDegraded: boolean;
  /** Le démarrage doit-il être refusé en production ? */
  blocking: boolean;
}

/**
 * État du catalogue tarifaire, sans effet de bord. Destiné à l'administration
 * (`/api/admin/ai/inventory`) et au contrôle de démarrage ci-dessous.
 */
export function getPricingReadiness(): PricingReadiness {
  const runningUseCases = listRunningUseCases();
  const missingForRunning = listModelsWithoutPricing({ runningOnly: true });
  return {
    runningUseCases,
    missingForRunning,
    missingOverall: listModelsWithoutPricing(),
    unverified: listUnverifiedPricing(),
    cacheDegraded: getCacheState().degraded,
    blocking: runningUseCases.length > 0 && missingForRunning.length > 0,
  };
}

/**
 * Contrôle de démarrage — CDC Assistant §15.14.
 *
 * ⚠️ CORRECTION D'UN DÉFAUT BLOQUANT. La première version refusait le démarrage
 * en production dès qu'un modèle du référentiel n'avait pas de tarif — y compris
 * lorsque les cinq drapeaux valaient `legacy`, c'est-à-dire lorsqu'AUCUN appel
 * ne passait par la nouvelle gateway. Le code livré était donc indéployable :
 * il exigeait, pour démarrer, des tarifs portant sur des appels qui n'avaient
 * pas lieu.
 *
 * La garantie du §15.14 est conservée, mais rapportée à son périmètre réel :
 * un tarif manquant ne bloque que si l'usage qui l'emploie s'exécute
 * effectivement (`enabled` ou `shadow`). Le mode observation est inclus
 * délibérément : il consomme des appels modèles, donc de l'argent.
 *
 * Hors production, jamais de blocage : les tests et le développement local n'ont
 * pas à dépendre de la disponibilité de l'API de facturation.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ SECOND DÉFAUT BLOQUANT, CONSTATÉ EN RECETTE LE 18/09/2026
 *
 * Changer le modèle par défaut de l'assistant a rendu la préproduction
 * indémarrable : `gemini-3.5-flash-lite` n'avait pas de tarif en base, donc ce
 * contrôle levait, donc l'application ne démarrait pas — donc la route qui
 * renseigne les tarifs, `/api/cron/ai/refresh-model-pricing`, était
 * inaccessible. Un verrou qui s'enferme lui-même : le seul remède demandait que
 * l'application tourne, ce que le verrou empêchait.
 *
 * La cause profonde n'était pas le modèle. C'était de refuser le démarrage pour
 * un tarif que le code CONNAÎT : le catalogue public, versionné dans le dépôt,
 * porte ce modèle depuis le 30/07/2026.
 *
 * Le contrôle essaie donc d'abord de combler les manques depuis ce catalogue,
 * puis relit. Ce qui reste manquant après cela est un modèle que personne ne
 * sait tarifer — et là, le blocage garde tout son sens.
 */
export async function assertPricingReady(): Promise<void> {
  // `loadedAt` et non `size` : un catalogue vide mais chargé est un état connu,
  // pas une raison de réinterroger la base à chaque appel.
  if (getCacheState().loadedAt === null) await loadPricingCache();

  let state = getPricingReadiness();

  // Auto-amorçage depuis le catalogue public avant de bloquer.
  if (state.blocking) state = await seedFromPublicCatalog(state);

  if (state.runningUseCases.length === 0) {
    console.info(
      '[ai-cost] Aucun usage IA basculé — contrôle tarifaire sans objet. ' +
      `${state.missingOverall.length} modèle(s) du référentiel restent sans tarif, ` +
      'à renseigner avant la première bascule.',
    );
    return;
  }

  if (state.missingForRunning.length > 0) {
    const message =
      `[ai-cost] Modèles sans tarif sur un usage actif (${state.runningUseCases.join(', ')}) : ` +
      `${state.missingForRunning.join(', ')}.`;
    if (process.env.NODE_ENV === 'production') throw new Error(message);
    console.warn(`${message} — coûts non calculables hors production.`);
  }

  if (state.unverified.length > 0) {
    console.warn(`[ai-cost] ⚠️ Tarifs saisis manuellement non confirmés : ${state.unverified.join(', ')}`);
  }
}

/**
 * Comble les tarifs manquants depuis le catalogue public embarqué.
 *
 * Les prix écrits portent `source: 'public_catalog'` et `verified: false` : ce
 * sont les tarifs affichés par le fournisseur, justes mais sans les remises
 * éventuelles du compte. L'écran Fournisseur IA les distingue déjà d'une grille
 * confirmée, et `/api/cron/ai/refresh-model-pricing` les remplacera dès qu'il
 * pourra être appelé.
 *
 * Écrire au démarrage se justifie ici, et seulement ici : sans cela le démarrage
 * échoue, et aucune route ne peut plus rien corriger.
 */
async function seedFromPublicCatalog(state: PricingReadiness): Promise<PricingReadiness> {
  // `toModelPrice` porte la conversion officielle. La refaire ici arrondirait
  // 0,3 $/million à zéro : les tarifs sont des décimales, pas des entiers.
  const { findCatalogEntry, toModelPrice } = await import('./pricing/gemini-public-catalog');
  const { upsertPrice } = await import('./pricing/pricing.repository');

  let comblés = 0;
  for (const manquant of state.missingForRunning) {
    // `missingForRunning` rend « provider/model ».
    const [provider, ...reste] = manquant.split('/');
    const model = reste.join('/');
    if (provider !== 'gemini') continue;
    const entry = findCatalogEntry(model);
    if (!entry) continue;

    try {
      await upsertPrice(toModelPrice(entry), 'public_catalog', false);
      comblés++;
    } catch (e) {
      console.error(`[ai-cost] Amorçage tarifaire impossible pour ${manquant} :`, (e as Error).message);
    }
  }

  if (comblés === 0) return state;

  console.warn(
    `[ai-cost] ${comblés} tarif(s) amorcé(s) depuis le catalogue public embarqué. ` +
    'Lancez /api/cron/ai/refresh-model-pricing pour obtenir la grille du compte.',
  );
  await loadPricingCache();
  return getPricingReadiness();
}

export { loadPricingCache, getCachedPrice } from './pricing/pricing.repository';
export type { ModelPrice } from './pricing/pricing-source.port';
