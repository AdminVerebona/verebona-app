/**
 * Garde tarifaire des voies d'appel HORS boucle de la passerelle — lot 114
 * (Trello #770, §4) : sondes génératives, épreuves de qualification, test du
 * fournisseur, sonde du disjoncteur. Aucun appel facturable ne part vers un
 * modèle dont le tarif n'est pas une preuve officielle admissible.
 *
 * Même règle et même référentiel que la passerelle (`pricing-eligibility`).
 * Statut illisible = refus (jamais de « fail-open »). Les lectures de
 * métadonnées (liste des modèles) ne sont pas concernées : elles ne
 * consomment aucun jeton.
 */
import { getCachedPrice, loadPricingCache, pricingReadState, refreshPricingCacheIfStale, selectApplicablePrices, verifiedTestPricesActive } from './pricing.repository';
import { MODEL_PRICING_UNVERIFIED, pricingEligibility, type PricingEligibility } from './pricing-eligibility';

export class ModelPricingUnverifiedError extends Error {
  readonly code = MODEL_PRICING_UNVERIFIED;
  constructor(public readonly model: string, public readonly label: string) {
    super(`${model} non sollicité : modèle sans tarif officiel vérifié (${label}).`);
    this.name = 'ModelPricingUnverifiedError';
  }
}

/**
 * Éligibilité tarifaire d'un modèle d'après le référentiel EN MÉMOIRE — point d'évaluation unique (passerelle,
 * sélecteurs, supervision, voies hors passerelle). Socle de test actif (refusé et ignoré hors `NODE_ENV=test`) :
 * tout modèle porte une preuve de test, y compris quand la base de test contient une ligne d'amorçage non confirmée.
 */
export function evaluatePricing(model: string, provider = 'gemini', now: Date = new Date()): PricingEligibility {
  const price = getCachedPrice(provider, model);
  if (verifiedTestPricesActive() && price) return { ok: true, price };
  return pricingEligibility(price, pricingReadState(), now);
}

/** Motif du refus tarifaire, ou `null` si le modèle peut être appelé. Ne lève jamais. */
export async function pricingRefusalFor(model: string, provider = 'gemini'): Promise<string | null> {
  try {
    if (!pricingReadState().loaded) await loadPricingCache();
    else await refreshPricingCacheIfStale();
  } catch { /* référentiel illisible : refus ci-dessous */ }
  const e = evaluatePricing(model, provider);
  return e.ok ? null : e.label;
}

/** Lève `ModelPricingUnverifiedError` AVANT tout appel si le tarif n'est pas admissible. */
export async function assertModelPricingVerified(model: string, provider = 'gemini'): Promise<void> {
  const refus = await pricingRefusalFor(model, provider);
  if (refus !== null) throw new ModelPricingUnverifiedError(model, refus);
}

/** Partage une liste de modèles : appelables / exclus pour motif tarifaire (ordre conservé). */
export async function splitByPricing(models: readonly string[], provider = 'gemini'): Promise<{ priced: string[]; unpriced: Array<{ model: string; reason: string }> }> {
  const priced: string[] = []; const unpriced: Array<{ model: string; reason: string }> = [];
  for (const m of models) {
    const refus = await pricingRefusalFor(m, provider);
    if (refus === null) priced.push(m); else unpriced.push({ model: m, reason: refus });
  }
  return { priced, unpriced };
}

/**
 * Contrôle tarifaire FINAL, lu dans la transaction de l'appelant (promotion, activation) — #770, R07 : le tarif
 * peut avoir été retiré ou invalidé entre la validation et l'écriture. Lecture directe du référentiel (pas du
 * cache d'instance). Lecture impossible = refus.
 */
export async function pricingRefusalInTx(
  sql: { unsafe: (query: string, params?: never[]) => Promise<unknown> }, model: string, provider = 'gemini',
): Promise<string | null> {
  // Socle de test (refusé et ignoré hors NODE_ENV=test) : même preuve de test que pour le référentiel en mémoire.
  if (verifiedTestPricesActive()) return null;
  let lisible = true;
  let rows: unknown[] = [];
  try {
    rows = (await sql.unsafe(
      `SELECT p.id, p.provider, p.model, p.input_micros, p.output_micros, p.currency,
              p.source, p.source_reference, p.verified, p.fetched_at, p.effective_from, p.tiers,
              (s.status = 'STALE') AS stale, s.status AS page_status, s.stale_since
         FROM ai_model_pricing p
         LEFT JOIN ai_model_price_status s ON s.provider = p.provider AND s.model = p.model
        WHERE p.provider = $1 AND p.model = $2 AND p.effective_from <= NOW() AND p.invalidated_at IS NULL`,
      [provider, model] as never[],
    )) as unknown[];
  } catch { lisible = false; }
  const price: ReturnType<typeof getCachedPrice> = selectApplicablePrices(rows as Parameters<typeof selectApplicablePrices>[0])[0] ?? null;
  const e = pricingEligibility(price, { degraded: !lisible, loaded: true });
  return e.ok ? null : e.label;
}
