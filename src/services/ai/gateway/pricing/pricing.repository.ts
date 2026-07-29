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
let degraded = false;
let lastError: string | null = null;

/** PostgreSQL `undefined_table` — la migration 0111 n'est pas encore appliquée. */
const UNDEFINED_TABLE = '42P01';

function key(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/**
 * Charge le tarif le plus récent de chaque modèle. À appeler au démarrage.
 *
 * ⚠️ NE LÈVE JAMAIS. Le premier déploiement lit forcément cette table avant
 * qu'elle n'existe : `ensureMigrations()` et le chargement du cache sont dans le
 * même processus de démarrage, et une exception ici empêchait purement et
 * simplement l'application de démarrer.
 *
 * L'échec est donc absorbé, mais jamais silencieux : le cache passe en état
 * `degraded`, visible en administration et exploité par `assertPricingReady()`.
 * Un coût non mesurable reste préférable à un coût inventé — et très préférable
 * à une application qui ne démarre pas.
 *
 * @returns nombre de tarifs chargés (0 si la table est absente ou illisible).
 */
export async function loadPricingCache(): Promise<number> {
  let rows: unknown;
  try {
    rows = await pgClient.unsafe(
      `SELECT DISTINCT ON (provider, model)
              provider, model, input_micros, output_micros, currency,
              source, source_reference, verified, fetched_at
         FROM ai_model_pricing
        WHERE effective_from <= NOW()
        ORDER BY provider, model, effective_from DESC`,
    );
  } catch (e) {
    const err = e as { code?: string; message?: string };
    cache.clear();
    loadedAt = new Date();
    degraded = true;
    lastError = err.message ?? String(e);

    if (err.code === UNDEFINED_TABLE) {
      console.warn(
        '[ai-cost] Table `ai_model_pricing` absente — catalogue tarifaire vide. ' +
        'Appliquez la migration 0111, puis /api/cron/ai/refresh-model-pricing.',
      );
    } else {
      console.error(`[ai-cost] Catalogue tarifaire illisible : ${lastError}`);
    }
    return 0;
  }

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
  degraded = false;
  lastError = null;
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
  degraded = false;
  lastError = null;
}

export function clearPricingCache(): void {
  cache.clear();
  loadedAt = null;
  degraded = false;
  lastError = null;
}

export function getCachedPrice(provider: string, model: string): CachedPrice | null {
  return cache.get(key(provider, model)) ?? null;
}

export interface PricingCacheState {
  size: number;
  loadedAt: Date | null;
  /** Le dernier chargement a échoué : les coûts ne sont pas mesurables. */
  degraded: boolean;
  lastError: string | null;
}

export function getCacheState(): PricingCacheState {
  return { size: cache.size, loadedAt, degraded, lastError };
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
