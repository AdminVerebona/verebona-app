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
import { getCachedPrice, getCacheState, loadPricingCache, startPricingCacheWatcher, type CachedPrice } from './pricing/pricing.repository';
import { rateFor, type PriceTier } from './pricing/google-pricing-page.adapter';

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
  if (price && requiresModalityUsage(price)) {
    // Lot 113O : tarif par modalité (texte ≠ image…) — la passerelle ne connaît
    // pas ici la consommation par modalité ; la trace la chiffre si elle est
    // mesurée (`trace-pricing.ts`), sinon le coût reste inconnu, jamais estimé.
    return null;
  }
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
  return Math.round(exactCostMicros(price, inputTokens, outputTokens, 0, new Date()));
}

/**
 * Coût EXACT (fraction de micro-dollar) d'une consommation au tarif `price`
 * (pur, lot 109L). Paliers :
 *   · taille d'invite (lot 35B) : au-delà du seuil, TOUTE la requête au tarif
 *     du palier ;
 *   · montants datés : celui en vigueur à la date de l'appel (`at`), sinon le
 *     montant de base relevé ;
 *   · jetons de raisonnement : facturés au tarif de SORTIE (« Output price
 *     (including thinking tokens) ») — ajoutés seulement s'ils sont connus.
 */
export function exactCostMicros(
  price: Pick<CachedPrice, 'inputMicros' | 'outputMicros' | 'tiers'>,
  inputTokens: number,
  outputTokens: number,
  thoughtsTokens: number,
  at: Date,
): number {
  const tiers = price.tiers ?? [];
  const palier = tiers
    .filter((t): t is Extract<PriceTier, { kind: 'prompt_tokens_above' }> => t.kind === 'prompt_tokens_above')
    .filter((t) => inputTokens > t.thresholdTokens)
    .sort((a, b) => b.thresholdTokens - a.thresholdTokens)[0];
  let inMicros = palier ? palier.inputPerMillion : price.inputMicros;
  let outMicros = palier ? palier.outputPerMillion : price.outputMicros;
  if (!palier) {
    const jour = at.toISOString().slice(0, 10);
    const date = tiers
      .filter((t): t is Extract<PriceTier, { kind: 'dated' }> => t.kind === 'dated')
      .find((t) => (t.from === null || t.from <= jour) && (t.to === null || jour <= t.to));
    if (date && date.inputPerMillion !== null) inMicros = date.inputPerMillion;
    if (date && date.outputPerMillion !== null) outMicros = date.outputPerMillion;
  }
  return inputTokens * inMicros + (outputTokens + Math.max(0, thoughtsTokens || 0)) * outMicros;
}

/**
 * Lot 113O — consommation PAR MODALITÉ (jetons), telle que Gemini la remonte
 * (`usageMetadata.promptTokensDetails` / `candidatesTokensDetails`), clés en
 * minuscules : text, image, audio, video, pdf (DOCUMENT).
 */
export interface ModalityUsage { input?: Record<string, number> | null; output?: Record<string, number> | null }

type ModalityTier = Extract<PriceTier, { kind: 'modality' }>;

/** Le tarif exige-t-il la consommation par modalité ? (pur) */
export function requiresModalityUsage(price: Pick<CachedPrice, 'tiers'>): boolean {
  return (price.tiers ?? []).some((t) => t.kind === 'modality' && t.requiresBreakdown);
}

const somme = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

/**
 * Coût EXACT avec prix par modalité (pur, lot 113O). Sans palier de modalité :
 * identique à `exactCostMicros`. Avec : chaque côté (entrée / sortie) est
 * chiffré modalité par modalité si la consommation par modalité est mesurée et
 * cohérente avec le total ; sinon, si le côté exige cette consommation, le coût
 * est INCONNU avec un motif précis (jamais un tarif textuel appliqué à une
 * image ou à de l'audio). Raisonnement : taux « thinking » sinon texte.
 */
export function modalityAwareCost(
  price: Pick<CachedPrice, 'inputMicros' | 'outputMicros' | 'tiers'>,
  inputTokens: number,
  outputTokens: number,
  thoughtsTokens: number,
  at: Date,
  usage?: ModalityUsage | null,
): { ok: true; exact: number } | { ok: false; code: 'MODALITY_USAGE_UNMEASURED' | 'MODALITY_NOT_PRICED'; reason: string } {
  const mods = (price.tiers ?? []).filter((t): t is ModalityTier => t.kind === 'modality');
  if (mods.length === 0) return { ok: true, exact: exactCostMicros(price, inputTokens, outputTokens, thoughtsTokens, at) };
  const autres = (price.tiers ?? []).filter((t) => t.kind !== 'modality');
  const base = { inputMicros: price.inputMicros, outputMicros: price.outputMicros, tiers: autres };
  const thoughts = Math.max(0, thoughtsTokens || 0);
  let exact = 0;
  for (const side of ['input', 'output'] as const) {
    const tier = mods.find((t) => t.side === side);
    const tokens = side === 'input' ? inputTokens : outputTokens;
    const mesure = side === 'input' ? usage?.input : usage?.output;
    // Côté sans taux par modalité : montant de base (paliers datés / d'invite compris).
    // (la sortie est calculée par différence : le palier d'invite dépend des jetons d'ENTRÉE).
    const entree = exactCostMicros(base, inputTokens, 0, 0, at);
    const coutBase = side === 'input' ? entree : exactCostMicros(base, inputTokens, outputTokens, thoughts, at) - entree;
    if (!tier) { exact += coutBase; continue; }
    const coherent = mesure && Object.keys(mesure).length > 0 && somme(mesure) === tokens;
    if (!coherent) {
      if (tier.requiresBreakdown && tokens > 0) {
        return { ok: false, code: 'MODALITY_USAGE_UNMEASURED', reason: `tarif ${side === 'input' ? 'd’entrée' : 'de sortie'} par modalité : consommation par modalité non mesurée` };
      }
      exact += coutBase;
      continue;
    }
    for (const [m, n] of Object.entries(mesure!)) {
      if (!n) continue;
      const taux = rateFor(tier.rates, m) ?? (tier.requiresBreakdown ? undefined : (side === 'input' ? price.inputMicros : price.outputMicros));
      if (taux === undefined) return { ok: false, code: 'MODALITY_NOT_PRICED', reason: `modalité « ${m} » sans prix publié (${side === 'input' ? 'entrée' : 'sortie'})` };
      exact += n * taux;
    }
    if (side === 'output' && thoughts > 0) exact += thoughts * (rateFor(tier.rates, 'thinking') ?? price.outputMicros);
  }
  return { ok: true, exact };
}

export interface CallPricing {
  /** `null` : aucun tarif applicable (coût non calculable, jamais estimé). */
  costMicros: number | null;
  exactMicros: number | null;
  price: CachedPrice | null;
  /** Lot 113O : tarif connu mais coût non calculable (consommation par modalité). */
  unknownCode?: 'MODALITY_USAGE_UNMEASURED' | 'MODALITY_NOT_PRICED';
  unknownReason?: string;
}

/**
 * Coût d'un appel avec jetons de raisonnement (lot 109L) — même cache, même
 * règle que `calcCostMicros`. Arrondi UNE fois, au micro-dollar, ici.
 */
export function priceCall(p: {
  provider: string; model: string; inputTokens: number; outputTokens: number; thoughtsTokens?: number | null; at?: Date;
  /** Lot 113O : consommation par modalité mesurée (facultative). */
  modality?: ModalityUsage | null;
}): CallPricing {
  const price = getCachedPrice(p.provider, p.model);
  if (!price) return { costMicros: null, exactMicros: null, price: null };
  const c = modalityAwareCost(price, p.inputTokens, p.outputTokens, p.thoughtsTokens ?? 0, p.at ?? new Date(), p.modality);
  if (!c.ok) return { costMicros: null, exactMicros: null, price, unknownCode: c.code, unknownReason: c.reason };
  return { costMicros: Math.round(c.exact), exactMicros: c.exact, price };
}

/**
 * Lot 16b-3 : plus aucun drapeau de bascule — tous les usages du référentiel
 * s'exécutent ; le périmètre « actif » est le référentiel entier.
 */
const runningUseCases = (): string[] => [...AI_USE_CASE_CODES];

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

interface PricingReadiness {
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
  // Lot 109L : rechargement sur changement écrit par une autre instance.
  startPricingCacheWatcher();

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
    // Lot 114 (Trello #770) — règle du lot 35B remplacée : le DÉMARRAGE n'est jamais bloqué, mais un modèle sans
    // tarif officiel vérifié n'est plus appelé (garde de la passerelle : rang sauté, rang configuré suivant essayé).
    console.warn(
      `[ai-cost] Modèles sans tarif connu (${state.missingForRunning.join(', ')}) : `
      + 'ils ne seront pas appelés tant que leur tarif officiel n’est pas vérifié (prochaine synchronisation tarifaire).',
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
