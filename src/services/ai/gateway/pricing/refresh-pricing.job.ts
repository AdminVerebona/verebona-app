/**
 * Lot de rafraîchissement des tarifs — CDC Assistant §15.13 (veille mensuelle).
 *
 * Relève la grille du compte Google pour les modèles réellement déclarés dans
 * le référentiel, et non pour une liste figée : ajouter un modèle aux
 * opérations suffit à le faire entrer dans le périmètre de veille.
 *
 * Le lot n'échoue jamais silencieusement : un modèle non apparié est journalisé
 * dans `models_missing` et devra être saisi en administration.
 */
import { pgClient } from '@/db';
import { listLlmOperations } from '../../registry/operations';
import { GeminiPricingSource } from './gemini-pricing.source';
import { upsertPrice, loadPricingCache } from './pricing.repository';
import type { PricingSource } from './pricing-source.port';

const sources: PricingSource[] = [new GeminiPricingSource()];

export interface RefreshResult {
  status: 'completed' | 'partial' | 'failed';
  modelsFound: number;
  modelsUpdated: number;
  modelsMissing: string[];
  error?: string;
}

/** Modèles à tarifer : déduits du référentiel, jamais d'une liste en dur. */
export function listModelsToPrice(): Map<string, Set<string>> {
  const byProvider = new Map<string, Set<string>>();
  for (const op of listLlmOperations()) {
    const set = byProvider.get(op.provider) ?? new Set<string>();
    set.add(op.primaryModel);
    op.fallbackModels.forEach((m) => set.add(m));
    byProvider.set(op.provider, set);
  }
  return byProvider;
}

export async function refreshModelPricing(): Promise<RefreshResult> {
  const logId = await openLog();
  const wanted = listModelsToPrice();
  const missing: string[] = [];
  let found = 0;
  let updated = 0;

  try {
    for (const source of sources) {
      const models = [...(wanted.get(source.provider) ?? [])];
      if (models.length === 0) continue;

      if (!source.isConfigured()) {
        missing.push(...models);
        continue;
      }

      const prices = await source.fetchPrices(models);
      found += prices.length;

      for (const price of prices) {
        // Un tarif relevé automatiquement est considéré comme vérifié : il vient
        // de la grille facturée au compte, pas d'une estimation.
        await upsertPrice(price, 'billing_api', true);
        updated++;
      }

      const returned = new Set(prices.map((p) => p.model));
      missing.push(...models.filter((m) => !returned.has(m)));
    }

    await loadPricingCache();

    const status = missing.length === 0 ? 'completed' : 'partial';
    await closeLog(logId, status, found, updated, missing);
    return { status, modelsFound: found, modelsUpdated: updated, modelsMissing: missing };
  } catch (e) {
    const message = (e as Error).message;
    await closeLog(logId, 'failed', found, updated, missing, message);
    return {
      status: 'failed', modelsFound: found, modelsUpdated: updated,
      modelsMissing: missing, error: message,
    };
  }
}

async function openLog(): Promise<number> {
  const rows = await pgClient.unsafe(
    `INSERT INTO ai_model_pricing_refresh_log (status) VALUES ('running') RETURNING id`,
  );
  return (rows as unknown as Array<{ id: number }>)[0].id;
}

async function closeLog(
  id: number, status: string, found: number, updated: number,
  missing: string[], error?: string,
): Promise<void> {
  await pgClient.unsafe(
    `UPDATE ai_model_pricing_refresh_log
        SET status = $2, finished_at = NOW(), models_found = $3,
            models_updated = $4, models_missing = $5::jsonb, error_message = $6
      WHERE id = $1`,
    [id, status, found, updated, JSON.stringify(missing), error ?? null] as never[],
  );
}
