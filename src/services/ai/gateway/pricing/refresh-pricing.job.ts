/**
 * Rafraîchissement des tarifs — CDC Assistant §15.13 (veille), lot 35B.
 *
 * Lot 35B : plus qu'un point d'entrée. La seule implémentation est
 * `syncPricingCatalog` (page officielle Google, historique, UNKNOWN jamais
 * inventé), appelée par la synchronisation du catalogue IA
 * (`ai-catalog-sync.service.ts` : tâche planifiée et bouton « Actualiser le
 * catalogue ») et par la route manuelle `/api/cron/ai/refresh-model-pricing`.
 */
import { listLlmOperations } from '../../registry/operations';
import { syncPricingCatalog, type PricingSyncDeps } from './pricing-sync.service';

export interface RefreshResult {
  status: 'completed' | 'partial' | 'failed';
  modelsFound: number;
  modelsUpdated: number;
  modelsMissing: string[];
  error?: string;
}

/** Modèles du référentiel des opérations (principal et replis), par fournisseur. */
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

/**
 * Modèles à tarifer : référentiel, configurations effectives, catalogue
 * découvert (modèles listés par le fournisseur). Lectures seulement.
 */
export async function modelsToPrice(): Promise<string[]> {
  const out = new Set<string>(listModelsToPrice().get('gemini') ?? []);
  try {
    const { configuredModelsInUse } = await import('../../provider/provider-test.service');
    for (const m of await configuredModelsInUse()) out.add(m);
  } catch { /* configuration illisible : référentiel seul */ }
  try {
    const { getCatalogState } = await import('../../provider/model-catalog.service');
    for (const m of (await getCatalogState()).models) if (m.available) out.add(m.model);
  } catch { /* catalogue illisible */ }
  return [...out].sort();
}

export async function refreshModelPricing(deps: PricingSyncDeps = {}): Promise<RefreshResult> {
  const r = await syncPricingCatalog(await modelsToPrice(), deps);
  return {
    status: r.status === 'skipped' ? 'failed' : r.status,
    modelsFound: r.known.length,
    modelsUpdated: r.changed.length,
    modelsMissing: r.unknown.map((u) => u.model),
    ...(r.error ? { error: r.error } : {}),
  };
}
