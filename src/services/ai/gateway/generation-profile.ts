/**
 * Lot 76A (T6, AC04) — PROFIL DE GÉNÉRATION EFFECTIF d'une opération (pur).
 *
 * Valeurs RÉSOLUES réellement appliquées par la passerelle (`AiGateway.execute`)
 * à un appel sans contrainte d'appelant (ni budget de tentatives, ni escalade,
 * ni plafond de sortie imposé) :
 *   · chaîne ORDONNÉE des modèles : principal, puis replis de la version ;
 *   · niveau de raisonnement de CHAQUE rang (`reasoningByRank`, `null` :
 *     défaut du modèle) — le niveau suit le modèle auquel il est attaché ;
 *   · plafond de sortie (`maxOutputTokens` de la version, sinon du code ;
 *     plancher `minOutputTokens` de l'opération).
 *
 * La passerelle s'en sert elle-même pour le niveau de chaque tentative et le
 * plafond de sortie : un consommateur de la signature (T6 EVALUATE) ne peut
 * donc pas diverger de ce qui part réellement chez le fournisseur.
 */

import { rankProfile, type OperationProfile } from '../config/operation-profiles';

/** Sous-ensemble de la configuration résolue (`ResolvedOperationConfig`) utile au profil. */
export interface GenerationConfigInput {
  primaryModel?: string | null;
  fallbackModels?: readonly string[] | null;
  reasoningByRank?: ReadonlyArray<string | null | undefined> | null;
  maxOutputTokens?: number | null;
  /** Lot 85C : profil de l'opération (rangs de la chaîne), s'il existe. */
  operationProfile?: OperationProfile | null;
  configVersionId?: number | null;
}

/** Sous-ensemble de la définition d'opération utile au profil. */
export interface GenerationOperationInput {
  minOutputTokens?: number;
  timeoutMs?: number;
}

export interface GenerationProfile {
  /**
   * Chaîne ordonnée : rang 0 = principal, puis replis. Lot 85C : avec un
   * profil d'opération, chaque rang porte son plafond de sortie (avant
   * adaptation aux capacités du modèle, faite par le constructeur unique).
   */
  models: Array<{ model: string; reasoning: string | null; maxOutputTokens?: number | null }>;
  /** Plafond de sortie transmis au fournisseur (`null` : défaut du fournisseur). */
  maxOutputTokens: number | null;
  /** Lot 85C : délai propre de l'opération (présent seulement avec un profil). */
  timeoutMs?: number;
}

/** Plafond de sortie de base (avant un éventuel plafond d'appelant). */
export function baseMaxOutputTokens(op: GenerationOperationInput, cfg: GenerationConfigInput): number | undefined {
  return op.minOutputTokens
    ? Math.max(cfg.maxOutputTokens ?? 0, op.minOutputTokens)
    : cfg.maxOutputTokens ?? undefined;
}

/**
 * Niveau de raisonnement appliqué au rang `rank` de la chaîne complète.
 * Lot 85C : le profil de l'opération pour ce rang prime sur le traitement.
 */
export function reasoningAtRank<R extends string>(cfg: { reasoningByRank?: ReadonlyArray<R | null | undefined> | null; operationProfile?: OperationProfile | null }, rank: number): R | null {
  return (cfg.operationProfile?.reasoningByRank?.[rank] as R | null | undefined) ?? cfg.reasoningByRank?.[rank] ?? null;
}

/**
 * Lot 85C (décision 08) — plafond de sortie DEMANDÉ pour un rang, avant
 * plancher de l'opération, plafond d'appelant et adaptation à la limite du
 * modèle (constructeur de requête). Une seule résolution : `rankProfile`.
 */
export function rankSettings(op: GenerationOperationInput, cfg: GenerationConfigInput, rank: number) {
  return rankProfile({ timeoutMs: op.timeoutMs ?? 0 }, cfg, rank);
}

/** Profil de génération effectif (pur, déterministe). */
export function effectiveGenerationProfile(op: GenerationOperationInput, cfg: GenerationConfigInput): GenerationProfile {
  const chaine = [cfg.primaryModel, ...(cfg.fallbackModels ?? [])].filter((m): m is string => typeof m === 'string');
  const plafond = baseMaxOutputTokens(op, cfg);
  // Sans profil d'opération : forme inchangée (signature T6 EVALUATE stable).
  if (!cfg.operationProfile) {
    return {
      models: chaine.map((model, rank) => ({ model, reasoning: reasoningAtRank(cfg, rank) })),
      maxOutputTokens: plafond && plafond > 0 ? plafond : null,
    };
  }
  const parRang = (rank: number) => {
    const r = rankSettings(op, cfg, rank).maxOutputTokens;
    const base = op.minOutputTokens ? Math.max(r ?? 0, op.minOutputTokens) : r;
    return base && base > 0 ? base : null;
  };
  return {
    models: chaine.map((model, rank) => ({ model, reasoning: reasoningAtRank(cfg, rank), maxOutputTokens: parRang(rank) })),
    maxOutputTokens: parRang(0),
    ...(op.timeoutMs ? { timeoutMs: rankSettings(op, cfg, 0).timeoutMs } : {}),
  };
}
