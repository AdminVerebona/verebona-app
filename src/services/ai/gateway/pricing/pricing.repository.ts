/**
 * Catalogue tarifaire — lecture et écriture.
 *
 * Le calcul de coût est synchrone dans la gateway : les tarifs sont donc
 * maintenus dans un cache mémoire, chargé au démarrage et rafraîchi par le lot
 * planifié. Aucun accès base n'a lieu pendant un appel modèle.
 */
import { pgClient } from '@/db';
import type { ModelPrice } from './pricing-source.port';

export interface CachedPrice extends ModelPrice {
  verified: boolean;
  fetchedAt: Date;
  source: 'billing_api' | 'manual';
}

const cache = new Map<string, CachedPrice>();
let loadedAt: Date | null = null;

function key(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/** Charge le tarif le plus récent de chaque modèle. À appeler au démarrage. */
export async function loadPricingCache(): Promise<number> {
  const rows = await pgClient.unsafe(
    `SELECT DISTINCT ON (provider, model)
            provider, model, input_micros, output_micros, currency,
            source, source_reference, verified, fetched_at
       FROM ai_model_pricing
      WHERE effective_from <= NOW()
      ORDER BY provider, model, effective_from DESC`,
  );

  cache.clear();
  for (const r of rows as Array<Record<string, unknown>>) {
    const p: CachedPrice = {
      provider: String(r.provider),
      model: String(r.model),
      inputMicros: Number(r.input_micros),
      outputMicros: Number(r.output_micros),
      currency: String(r.currency),
      source: r.source as 'billing_api' | 'manual',
      sourceReference: r.source_reference ? String(r.source_reference) : undefined,
      verified: Boolean(r.verified),
      fetchedAt: new Date(String(r.fetched_at)),
    };
    cache.set(key(p.provider, p.model), p);
  }

  loadedAt = new Date();
  return cache.size;
}

/**
 * Amorce le cache sans passer par la base.
 *
 * Réservé aux tests et à un amorçage local. En production, le cache est
 * alimenté par `loadPricingCache()` depuis `ai_model_pricing`.
 */
export function primePricingCache(prices: CachedPrice[]): void {
  for (const p of prices) cache.set(key(p.provider, p.model), p);
  loadedAt = new Date();
}

export function clearPricingCache(): void {
  cache.clear();
  loadedAt = null;
}

export function getCachedPrice(provider: string, model: string): CachedPrice | null {
  return cache.get(key(provider, model)) ?? null;
}

export function getCacheState(): { size: number; loadedAt: Date | null } {
  return { size: cache.size, loadedAt };
}

/**
 * Enregistre un tarif. Une nouvelle ligne est créée à chaque relevé : un coût
 * passé doit rester explicable avec le tarif en vigueur au moment de l'appel.
 */
export async function upsertPrice(
  price: ModelPrice,
  source: 'billing_api' | 'manual',
  verified: boolean,
  verifiedBy?: number,
): Promise<void> {
  await pgClient.unsafe(
    `INSERT INTO ai_model_pricing (
       provider, model, input_micros, output_micros, currency,
       source, source_reference, verified, verified_by, effective_from, fetched_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
     ON CONFLICT (provider, model, effective_from) DO UPDATE SET
       input_micros = EXCLUDED.input_micros,
       output_micros = EXCLUDED.output_micros,
       fetched_at = NOW()`,
    [
      price.provider, price.model, price.inputMicros, price.outputMicros,
      price.currency, source, price.sourceReference ?? null, verified,
      verifiedBy ?? null,
    ] as never[],
  );
}
