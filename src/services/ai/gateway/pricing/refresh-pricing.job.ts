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
import { GeminiPublicPricingSource } from './gemini-public.source';
import { upsertPrice, loadPricingCache } from './pricing.repository';
import type { PricingSource, ModelPrice } from './pricing-source.port';

/**
 * Sources par ordre de priorité CROISSANTE : la dernière configurée l'emporte.
 *
 *   1. Catalogue public — toujours disponible, tarifs relevés à la main puis
 *      contrôlés contre la page officielle.
 *   2. Cloud Billing Catalog — la grille réellement facturée au compte, seule
 *      à refléter d'éventuels tarifs négociés (CDC §29.5). Ne prend le relais
 *      que si `GOOGLE_BILLING_API_KEY` est fournie.
 *
 * Sans clé de facturation, l'application dispose donc de tarifs justes au
 * tarif public — et non plus de tarifs inventés.
 */
const sources: PricingSource[] = [
  new GeminiPublicPricingSource(),
  new GeminiPricingSource(),
];

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
    // Les tarifs sont d'abord collectés de toutes les sources, PUIS écrits.
    // La version précédente écrivait source par source et comptait comme
    // manquant tout modèle qu'une source ne connaissait pas — y compris quand
    // une autre source l'avait fourni.
    const resolved = new Map<string, { price: ModelPrice; sourceName: string }>();
    const providers = new Set(sources.map((s) => s.provider));

    for (const source of sources) {
      const models = [...(wanted.get(source.provider) ?? [])];
      if (models.length === 0 || !source.isConfigured()) continue;

      const prices = await source.fetchPrices(models);
      for (const price of prices) {
        // Source plus prioritaire : elle remplace la précédente.
        resolved.set(`${price.provider}:${price.model}`, { price, sourceName: source.name });
      }
    }

    for (const { price, sourceName } of resolved.values()) {
      // `verified` distingue la grille du compte (opposable à la facture) du
      // tarif public (juste, mais sans les remises éventuelles).
      const fromPublicPage = sourceName === 'google-public-pricing-page';
      await upsertPrice(
        price,
        fromPublicPage ? 'public_catalog' : 'billing_api',
        !fromPublicPage,
      );
      updated++;
    }
    found = resolved.size;

    for (const provider of providers) {
      for (const model of wanted.get(provider) ?? []) {
        if (!resolved.has(`${provider}:${model}`)) missing.push(model);
      }
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
