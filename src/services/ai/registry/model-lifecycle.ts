/**
 * Statut fournisseur d'un modèle (stable / preview / experimental / deprecated)
 * — lot 35B, ticket « Catalogue IA dynamique Google ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE ISOLÉE, POUR POUVOIR ÉVOLUER
 *
 *   · Preview : INFORMATIF, jamais bloquant (sélectionnable comme un stable
 *     dès que la qualification technique réussit) ;
 *   · Experimental : NON SÉLECTIONNABLE en V1 ;
 *   · Deprecated : non proposé pour une nouvelle sélection.
 *
 * Source, par ordre de priorité :
 *   1. un champ STRUCTURÉ rendu par le fournisseur (`launchStage`, `stage`,
 *      `lifecycle` — convention des API Google Cloud) : il fait foi ;
 *   2. à défaut — c'est le cas de `GET /v1beta/models` au 10/10/2026, qui ne
 *      rend ni stade de lancement ni statut (champs : name, baseModelId,
 *      version, displayName, description, inputTokenLimit, outputTokenLimit,
 *      supportedGenerationMethods, thinking, temperature, topP, topK…) — la
 *      convention de nommage PUBLIÉE par Google (identifiant `…-preview…`,
 *      `…-exp…`, libellé « Preview » / « Experimental »).
 *
 * Le jour où Google publie un statut structuré, seul ce module change.
 * Module PUR (aucun accès base), testé (`model-lifecycle.test.ts`).
 * ══════════════════════════════════════════════════════════════════════════
 */

export type ProviderLifecycle = 'stable' | 'preview' | 'experimental' | 'deprecated';

export interface ProviderLifecycleInput {
  model: string;
  displayName?: string | null;
  description?: string | null;
  /** Champ structuré éventuel du fournisseur (stade de lancement). */
  launchStage?: string | null;
}

export interface ProviderLifecycleResult {
  status: ProviderLifecycle;
  /** `structured` : champ du fournisseur ; `name_rule` : convention de nommage. */
  basis: 'structured' | 'name_rule';
}

/** Stades de lancement Google Cloud → statut Verebona. Inconnu : non structuré. */
const STRUCTURED: Readonly<Record<string, ProviderLifecycle>> = {
  GA: 'stable',
  STABLE: 'stable',
  GENERAL_AVAILABILITY: 'stable',
  PREVIEW: 'preview',
  PUBLIC_PREVIEW: 'preview',
  PRIVATE_PREVIEW: 'preview',
  BETA: 'preview',
  EXPERIMENTAL: 'experimental',
  ALPHA: 'experimental',
  EARLY_ACCESS: 'experimental',
  PRELAUNCH: 'experimental',
  DEPRECATED: 'deprecated',
  RETIRED: 'deprecated',
};

/** Statut fourni de manière structurée, sinon `null`. */
export function structuredLifecycle(launchStage: string | null | undefined): ProviderLifecycle | null {
  if (typeof launchStage !== 'string' || launchStage.trim() === '') return null;
  const k = launchStage.trim().toUpperCase().replace(/^LAUNCH_STAGE_/, '').replace(/[\s-]+/g, '_');
  return STRUCTURED[k] ?? null;
}

/** Jetons « experimental » de la convention de nommage (`-exp`, `-exp-0827`, `experimental`). */
const EXPERIMENTAL_ID = /(^|[-_.])(exp|experimental)([-_.]|\d|$)/i;
const PREVIEW_ID = /(^|[-_.])preview([-_.]|\d|$)/i;

/**
 * Statut fournisseur d'un modèle listé. Le libellé et la description ne
 * servent qu'en l'absence de champ structuré, et seulement pour les mots
 * « Experimental » / « Preview » pris isolément.
 */
export function providerLifecycle(input: ProviderLifecycleInput): ProviderLifecycleResult {
  const s = structuredLifecycle(input.launchStage);
  if (s) return { status: s, basis: 'structured' };
  const id = input.model.trim();
  const libelle = `${input.displayName ?? ''}`;
  if (EXPERIMENTAL_ID.test(id) || /\bexperimental\b/i.test(libelle)) return { status: 'experimental', basis: 'name_rule' };
  if (PREVIEW_ID.test(id) || /\bpreview\b/i.test(libelle)) return { status: 'preview', basis: 'name_rule' };
  return { status: 'stable', basis: 'name_rule' };
}

export const PROVIDER_LIFECYCLE_LABELS: Readonly<Record<ProviderLifecycle, string>> = {
  stable: 'Stable',
  preview: 'Preview',
  experimental: 'Expérimental',
  deprecated: 'Déprécié',
};
