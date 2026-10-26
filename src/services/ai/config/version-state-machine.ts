/**
 * États d'une version de configuration IA — lot 54 (54C), ticket « BO-IA —
 * Refonte de la gestion des versions ».
 *
 * Le workflow Brouillon → À tester → Validé → Archivé (CDC BO IA §4.1, §7)
 * est SUPPRIMÉ : une version est active (une seule par environnement, garantie
 * par l'index unique partiel `ai_config_versions_single_active_idx`) ou non
 * active. La version active reste entièrement modifiable ; une version non
 * active peut être supprimée (logiquement).
 *
 * Les anciennes valeurs restent LISIBLES : une ligne insérée par une sauvegarde
 * antérieure ou un outil (tests) avec `DRAFT`, `TO_TEST`, `VALIDATED` ou
 * `ARCHIVED` est traitée comme non active. Le code n'en écrit plus aucune.
 */
import type { AiEnvironment } from './environment';

/** Statuts écrits par le code depuis le lot 54. */
export type ConfigVersionState = 'ACTIVE' | 'INACTIVE';

/** Statuts lisibles en base (anciens compris, migration 0376). */
export type ConfigVersionStatus = ConfigVersionState | 'DRAFT' | 'TO_TEST' | 'VALIDATED' | 'ARCHIVED';

function isActiveStatus(status: string | null | undefined): boolean {
  return status === 'ACTIVE';
}

/** Libellé d'état pour les écrans, selon l'environnement. */
export function stateLabel(status: string, environment: AiEnvironment | string): string {
  if (!isActiveStatus(status)) return 'Non active';
  return environment === 'production' ? 'Active en production' : 'Active en préproduction';
}
