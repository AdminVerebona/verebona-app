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

/** Sous-ensemble de la configuration résolue (`ResolvedOperationConfig`) utile au profil. */
export interface GenerationConfigInput {
  primaryModel?: string | null;
  fallbackModels?: readonly string[] | null;
  reasoningByRank?: ReadonlyArray<string | null | undefined> | null;
  maxOutputTokens?: number | null;
}

/** Sous-ensemble de la définition d'opération utile au profil. */
export interface GenerationOperationInput {
  minOutputTokens?: number;
}

export interface GenerationProfile {
  /** Chaîne ordonnée : rang 0 = principal, puis replis. */
  models: Array<{ model: string; reasoning: string | null }>;
  /** Plafond de sortie transmis au fournisseur (`null` : défaut du fournisseur). */
  maxOutputTokens: number | null;
}

/** Plafond de sortie de base (avant un éventuel plafond d'appelant). */
export function baseMaxOutputTokens(op: GenerationOperationInput, cfg: GenerationConfigInput): number | undefined {
  return op.minOutputTokens
    ? Math.max(cfg.maxOutputTokens ?? 0, op.minOutputTokens)
    : cfg.maxOutputTokens ?? undefined;
}

/** Niveau de raisonnement appliqué au rang `rank` de la chaîne complète. */
export function reasoningAtRank<R extends string>(cfg: { reasoningByRank?: ReadonlyArray<R | null | undefined> | null }, rank: number): R | null {
  return cfg.reasoningByRank?.[rank] ?? null;
}

/** Profil de génération effectif (pur, déterministe). */
export function effectiveGenerationProfile(op: GenerationOperationInput, cfg: GenerationConfigInput): GenerationProfile {
  const chaine = [cfg.primaryModel, ...(cfg.fallbackModels ?? [])].filter((m): m is string => typeof m === 'string');
  const plafond = baseMaxOutputTokens(op, cfg);
  return {
    models: chaine.map((model, rank) => ({ model, reasoning: reasoningAtRank(cfg, rank) })),
    maxOutputTokens: plafond && plafond > 0 ? plafond : null,
  };
}
