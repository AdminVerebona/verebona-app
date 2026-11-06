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
import { modelsActuallyUsed, syncPricingCatalog, type PricingSyncDeps, type PricingSyncResult } from './pricing-sync.service';

interface RefreshResult {
  status: 'completed' | 'partial' | 'failed';
  modelsFound: number;
  modelsUpdated: number;
  modelsMissing: string[];
  /** Lot 109L : tarifs conservés non confirmés, code d'échec global, capture de la page. */
  modelsStale?: string[];
  failureCode?: string;
  capture?: PricingSyncResult['capture'];
  error?: string;
}

/** Modèles du référentiel des opérations (principal et replis), par fournisseur. */
function listModelsToPrice(): Map<string, Set<string>> {
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
  // Lot 109L (point B) : modèles RÉELLEMENT appelés (30 jours) — un modèle
  // utilisé mais absent du référentiel et du catalogue était jamais tarifé.
  try {
    for (const m of await modelsActuallyUsed(30)) out.add(m);
  } catch { /* table illisible */ }
  // Lot 113O : modèles SERVIS par l'API pour un alias (`modelVersion` des
  // traces) — tarifés à leur identifiant exact, jamais par ressemblance.
  try {
    const { servedModelsObserved } = await import('./pricing-supervision');
    for (const m of (await servedModelsObserved(30)).values()) for (const servi of m.keys()) out.add(servi);
  } catch { /* table illisible */ }
  return [...out].sort();
}

export async function refreshModelPricing(deps: PricingSyncDeps = {}): Promise<RefreshResult> {
  const r = await syncPricingCatalog(await modelsToPrice(), deps);
  return {
    status: r.status === 'skipped' ? 'failed' : r.status,
    modelsFound: r.known.length,
    modelsUpdated: r.changed.length,
    modelsMissing: r.unknown.map((u) => u.model),
    modelsStale: (r.stale ?? []).map((u) => u.model),
    ...(r.failureCode ? { failureCode: r.failureCode } : {}),
    ...(r.capture ? { capture: r.capture } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}
