/**
 * Seuils de non-escalade de T2, lus dans la gouvernance IA.
 *
 * Ils existaient (`ai_config_entries.cascade`, migration 0135) mais aucun
 * code de l'assistant ne les lisait : seuls des scores codés en dur
 * décidaient. Ils participent désormais à chaque décision de suffisance.
 *
 * Lecture bornée (1,5 s) et mise en cache (30 s) : un incident de lecture de
 * la configuration ne doit ni ralentir ni bloquer une réponse — les seuils
 * par défaut s'appliquent alors, et la trace l'indique (`source: 'default'`).
 */
import { DEFAULT_THRESHOLDS, sanitizeThresholds, type CascadeThresholdsLike } from './sufficiency';

let cache: { value: CascadeThresholdsLike & { source: 'governance' | 'default' }; expiresAt: number } | null = null;
const TTL_MS = 30_000;
const TIMEOUT_MS = 1_500;

export async function loadCascadeThresholds(): Promise<CascadeThresholdsLike & { source: 'governance' | 'default' }> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  let value: CascadeThresholdsLike & { source: 'governance' | 'default' } = { ...DEFAULT_THRESHOLDS, source: 'default' };
  try {
    const { getEffectiveVersion } = await import('@/services/ai/config/config-version.repository');
    const version = await Promise.race([
      getEffectiveVersion(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
    ]);
    const t2 = version?.entries.find((e) => e.treatment === 'T2');
    if (t2?.cascade) value = { ...sanitizeThresholds(t2.cascade), source: 'governance' };
  } catch {
    // Seuils par défaut : la réponse ne dépend pas de la disponibilité de la configuration.
  }
  cache = { value, expiresAt: Date.now() + TTL_MS };
  return value;
}

/** Réservé aux tests. */
export function resetCascadeThresholdsCache(): void {
  cache = null;
}
