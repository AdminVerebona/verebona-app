/**
 * Variables d'environnement RETIRÉES du code IA (lot 16b, retrait de l'ancien
 * moteur ; CDC 15 T2-43). Module pur, sans base : lu par
 * `prompt-architecture#promptArchitectureWarnings` (/api/health) et par
 * `ai:cutover-check`.
 *
 * Après L16b, la préproduction n'a plus AUCUN drapeau `AI_*` ni commutateur
 * de déploiement : une variable de cette liste encore posée est ignorée par
 * le code, et signalée pour être supprimée chez l'hébergeur.
 */
export interface RetiredVariable {
  name: string;
  /** Sous-lot qui l'a retirée. */
  lot: string;
  /** Ce que fait le code désormais. */
  now: string;
}

export const RETIRED_AI_VARIABLES: readonly RetiredVariable[] = [
  // CDC 15 T2-43 (lot 15)
  { name: 'VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS', lot: 'T2-43', now: 'plafond de la configuration IA (T2), borné à 500' },
  // L16b-1
  { name: 'AI_PROMPT_GOVERNANCE', lot: 'L16b-1', now: 'T5 toujours en master' },
  { name: 'AI_HOME_MASCOT', lot: 'L16b-1', now: 'T6 toujours en master' },
  { name: 'AI_DURABLE_QUEUE', lot: 'L16b-1', now: 'file T1 durable seule' },
  { name: 'ANALYSIS_QUEUE_CONCURRENCY', lot: 'L16b-1', now: 'AI_QUEUE_CONCURRENCY' },
  // L16b-2
  { name: 'AI_INTELLIGENT_ASSISTANT', lot: 'L16b-2', now: 'T2 toujours en master' },
  { name: 'AI_AGENDA_ENGINE', lot: 'L16b-2', now: 'T4 toujours en master' },
  { name: 'ASSISTANT_CANONICAL_READ', lot: 'L16b-2', now: 'lecture canonique seule' },
  { name: 'AI_T4_EFFECTS', lot: 'L16b-2', now: 'effets agenda T4 toujours actifs' },
  // L16b-3
  { name: 'AI_UNIFIED_SOURCE_ANALYSIS', lot: 'L16b-3', now: 'T1 toujours en master' },
  { name: 'AI_T1_ANALYSIS_MODE', lot: 'L16b-3', now: 'T1 toujours en master' },
  { name: 'AI_T1_SHADOW_SAMPLE_RATE', lot: 'L16b-3', now: 'plus de mode observation T1' },
  { name: 'AI_T1_SHADOW_MAX_CONCURRENCY', lot: 'L16b-3', now: 'plus de mode observation T1' },
  { name: 'AI_RECONCILIATION_ENGINE', lot: 'L16b-3', now: 'T3 toujours en master, écritures appliquées' },
  { name: 'T3_NEGATIVE_RECONCILIATION', lot: 'L16b-3', now: 'réconciliation négative toujours active' },
  { name: 'CANONICAL_WRITE_MODE', lot: 'L16b-3', now: 'écriture canonique seule' },
  { name: 'EXPORTS_CANONICAL_SOURCE', lot: 'L16b-3', now: 'exports sur la source canonique seule' },
];

/** Variables retirées encore posées dans `env` (valeur non vide). */
export function retiredVariablesSet(env: Record<string, string | undefined>): Array<RetiredVariable & { value: string }> {
  return RETIRED_AI_VARIABLES
    .filter((v) => (env[v.name] ?? '').trim() !== '')
    .map((v) => ({ ...v, value: String(env[v.name]) }));
}
