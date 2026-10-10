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
import { AI_USE_CASE_CODES } from '../registry/use-cases';
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
        `[ai-cost] Aucun tarif connu pour ${key} — coût non calculable (jamais estimé). ` +
        'La synchronisation du catalogue IA (tâche planifiée, ou « Actualiser le catalogue ») le relèvera dès que la page officielle le publie.',
      );
    }
    return null;
  }
  // Lot 35B : palier de taille d'invite (ex. au-delà de 200 000 jetons) — le
  // fournisseur facture alors TOUTE la requête au tarif du palier.
  const palier = (price.tiers ?? [])
    .filter((t): t is Extract<NonNullable<typeof price.tiers>[number], { kind: 'prompt_tokens_above' }> => t.kind === 'prompt_tokens_above')
    .filter((t) => inputTokens > t.thresholdTokens)
    .sort((a, b) => b.thresholdTokens - a.thresholdTokens)[0];
  const inMicros = palier ? palier.inputPerMillion : price.inputMicros;
  const outMicros = palier ? palier.outputPerMillion : price.outputMicros;
  return Math.round(inputTokens * inMicros + outputTokens * outMicros);
}

/**
 * Lot 16b-3 : plus aucun drapeau de bascule — tous les usages du référentiel
 * s'exécutent ; le périmètre « actif » est le référentiel entier.
 */
export const runningUseCases = (): string[] => [...AI_USE_CASE_CODES];

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

export interface PricingReadiness {
  /** Usages qui s'exécutent (tous depuis le lot 16b-3). */
  runningUseCases: string[];
  /** Tarifs manquants sur le périmètre réellement actif — seuls bloquants. */
  missingForRunning: string[];
  /** Tarifs manquants sur l'ensemble du référentiel — informatif. */
  missingOverall: string[];
  unverified: string[];
  cacheDegraded: boolean;
  /**
   * Toujours `false` depuis le lot 35B : un modèle sans tarif connu reste
   * utilisable (coût « non calculable »), et le démarrage n'est jamais
   * refusé pour un tarif. Conservé pour les écrans qui le lisent.
   */
  blocking: boolean;
}

/**
 * État du catalogue tarifaire, sans effet de bord. Destiné à l'administration
 * (`/api/admin/ai/inventory`) et au contrôle de démarrage ci-dessous.
 */
export function getPricingReadiness(): PricingReadiness {
  const actifs = runningUseCases();
  const missingForRunning = listModelsWithoutPricing();
  return {
    runningUseCases: actifs,
    missingForRunning,
    missingOverall: missingForRunning,
    unverified: listUnverifiedPricing(),
    cacheDegraded: getCacheState().degraded,
    blocking: false,
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
 * puis relit.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 35B — PLUS JAMAIS BLOQUANT
 *
 * Ticket « Catalogue IA dynamique Google » : un modèle sans tarif connu
 * (`pricingStatus = UNKNOWN`) reste utilisable ; ses appels fonctionnent, ses
 * jetons sont comptés, son coût est marqué non calculable. Ce contrôle ne
 * lève donc plus, dans aucun environnement : il signale.
 */
export async function assertPricingReady(): Promise<void> {
  // `loadedAt` et non `size` : un catalogue vide mais chargé est un état connu,
  // pas une raison de réinterroger la base à chaque appel.
  if (getCacheState().loadedAt === null) await loadPricingCache();

  let state = getPricingReadiness();

  // Amorçage depuis le relevé public embarqué des seuls modèles que la
  // synchronisation tarifaire n'a JAMAIS évalués (lot 35B).
  if (state.missingForRunning.length > 0) state = await seedFromPublicCatalog(state);

  if (state.runningUseCases.length === 0) {
    console.info(
      '[ai-cost] Aucun usage IA basculé — contrôle tarifaire sans objet. ' +
      `${state.missingOverall.length} modèle(s) du référentiel restent sans tarif, ` +
      'à renseigner avant la première bascule.',
    );
    return;
  }

  if (state.missingForRunning.length > 0) {
    // Lot 35B : JAMAIS bloquant, dans aucun environnement. Les appels
    // fonctionnent, les jetons sont comptés, le coût est « non calculable »
    // (jamais estimé) et les agrégats le distinguent des coûts connus.
    console.warn(
      `[ai-cost] Modèles sans tarif connu (${state.missingForRunning.join(', ')}) : `
      + 'appels autorisés, coûts marqués non calculables jusqu’à la prochaine synchronisation tarifaire.',
    );
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

  // Lot 35B : un modèle déjà évalué par la synchronisation (KNOWN ou UNKNOWN
  // dans `ai_model_price_status`) n'est JAMAIS réamorcé depuis le relevé
  // embarqué — un tarif retiré pour ambiguïté ne doit pas revenir au
  // redémarrage.
  const evalues = new Set<string>();
  try {
    const { pgClient } = await import('@/db');
    const rows = await pgClient.unsafe(`SELECT model FROM ai_model_price_status WHERE provider = 'gemini'`);
    for (const r of rows as unknown as Array<{ model: string }>) evalues.add(String(r.model));
  } catch { /* table absente (0304) : aucun modèle évalué */ }

  let comblés = 0;
  for (const manquant of state.missingForRunning) {
    // `missingForRunning` rend « provider/model ».
    const [provider, ...reste] = manquant.split('/');
    const model = reste.join('/');
    if (provider !== 'gemini' || evalues.has(model)) continue;
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
    'La synchronisation du catalogue IA les remplacera par les tarifs de la page officielle.',
  );
  await loadPricingCache();
  return getPricingReadiness();
}

export { loadPricingCache, getCachedPrice } from './pricing/pricing.repository';
export type { ModelPrice } from './pricing/pricing-source.port';
