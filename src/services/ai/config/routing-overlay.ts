/**
 * Surcouche de routage — PURE (aucune base) — lot 86B (CDC Pilotage IA V2,
 * phase P6 : ACT-03, OPT-03, DEC-03). Partagée par le résolveur de
 * configuration (exécution), le service de routage et les exclusions.
 */
import type { Treatment } from './treatments';
import type { TreatmentConfig } from './config-types';

/** Portée d'une intervention, réduite à ce que la surcouche lit. */
export interface OverlayIntervention { kind: 'EXCLUSION' | 'FREEZE'; model: string | null; treatment: Treatment | null }

/** Le modèle est-il exclu pour ce traitement (exclusion globale ou propre) ? */
export function isModelExcluded(model: string, treatment: Treatment | null, exclusions: ReadonlyArray<OverlayIntervention>): boolean {
  return exclusions.some((x) => x.kind === 'EXCLUSION' && x.model === model && (x.treatment === null || x.treatment === treatment));
}

/** Rang de la chaîne configurée : modèle et emplacement administré d'origine (0, 1, 2). */
interface ChainSlot<T = unknown> { model: string; slot: number; extra?: T }

export interface RoutingOverlay {
  exclusions: ReadonlyArray<OverlayIntervention>;
  /** Modèle promu par opération. */
  promotions: ReadonlyMap<string, { model: string; promotionId: number }>;
}

interface OverlayResult<T> {
  chain: Array<ChainSlot<T>>;
  /** Modèles retirés par une exclusion active. */
  excluded: string[];
  /** Exclusions NON appliquées parce qu'elles auraient vidé la chaîne. */
  exclusionIgnored: boolean;
  promotedModel: string | null;
  promotionId: number | null;
}

/**
 * Applique exclusions puis promotion à la chaîne CONFIGURÉE d'une opération
 * (pur). Jamais de modèle ajouté ; jamais de chaîne vidée (dans ce cas les
 * exclusions ne s'appliquent pas et c'est signalé — leur création l'interdit,
 * seule une configuration modifiée depuis peut y conduire).
 */
export function applyRoutingOverlay<T>(
  chain: ReadonlyArray<ChainSlot<T>>,
  treatment: Treatment,
  operationCode: string,
  overlay: RoutingOverlay,
): OverlayResult<T> {
  const excluded = chain.filter((c) => isModelExcluded(c.model, treatment, overlay.exclusions)).map((c) => c.model);
  let restante = chain.filter((c) => !excluded.includes(c.model));
  let exclusionIgnored = false;
  if (restante.length === 0 && chain.length > 0) { restante = [...chain]; exclusionIgnored = excluded.length > 0; }
  const promo = overlay.promotions.get(operationCode);
  let promotedModel: string | null = null;
  let promotionId: number | null = null;
  if (promo) {
    const i = restante.findIndex((c) => c.model === promo.model);
    if (i > 0) restante = [restante[i], ...restante.slice(0, i), ...restante.slice(i + 1)];
    if (i >= 0) { promotedModel = promo.model; promotionId = promo.promotionId; }
  }
  return { chain: restante, excluded: exclusionIgnored ? [] : excluded, exclusionIgnored, promotedModel, promotionId };
}

/** Chaîne configurée d'une ligne : emplacements renseignés, dans l'ordre. */
export function configuredChain(entry: Pick<TreatmentConfig, 'primaryModel' | 'fallback1' | 'fallback2'>): ChainSlot[] {
  return [entry.primaryModel, entry.fallback1, entry.fallback2]
    .map((model, slot) => ({ model: model ?? '', slot }))
    .filter((c) => c.model !== '');
}
