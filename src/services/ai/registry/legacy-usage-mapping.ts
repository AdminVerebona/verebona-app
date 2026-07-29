/**
 * Correspondance des identifiants historiques vers les cinq usages.
 * CDC §9.7 — « Migrer les historiques vers les cinq identifiants, sans
 * réécrire les événements passés. »
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE FICHIER EXISTE
 *
 * La migration 0110 crée `ai_legacy_usage_mapping` et complète `use_case_code`
 * sur les lignes existantes. Mais elle ne s'exécute **qu'une fois**, au
 * déploiement.
 *
 * Or les moteurs historiques continuent de tourner tant que les drapeaux valent
 * `legacy`, c'est-à-dire pendant toute la durée du chantier — plusieurs mois.
 * Chaque événement qu'ils produisent après ce déploiement repart donc sans
 * `use_case_code`, et le tableau de suivi par usage voit grossir une catégorie
 * « non rattaché » qui n'existait pas au moment de la migration.
 *
 * Autrement dit, la migration rattachait le passé et laissait le présent
 * dériver. Cette table rattache aussi le présent, à l'écriture.
 *
 * ⚠️ ELLE DOIT RESTER IDENTIQUE À LA MIGRATION 0110. Un test compare les deux
 * en lisant le fichier SQL : si l'une change sans l'autre, la suite échoue.
 * C'est le seul moyen d'éviter que l'historique et les nouvelles lignes soient
 * agrégés selon deux règles différentes — un écart qui ne se verrait qu'à la
 * lecture d'un tableau de bord, des mois plus tard.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { AiUseCaseCode } from './use-cases';

export interface LegacyUsageMapping {
  useCaseCode: AiUseCaseCode;
  /** Opération cible du référentiel — indicative, pour la lecture. */
  operationCode: string;
  /** Numéro d'usage dans l'ancienne nomenclature à onze. */
  legacyUsageNo: number;
}

export const LEGACY_USAGE_MAPPING: Record<string, LegacyUsageMapping> = {
  document_analysis:  { useCaseCode: 'SOURCE_ANALYSIS',       operationCode: 'extract_source',      legacyUsageNo: 1 },
  detect_groups:      { useCaseCode: 'SOURCE_ANALYSIS',       operationCode: 'group_sources',       legacyUsageNo: 1 },
  extract_full:       { useCaseCode: 'SOURCE_ANALYSIS',       operationCode: 'extract_source',      legacyUsageNo: 2 },
  web_link_analysis:  { useCaseCode: 'SOURCE_ANALYSIS',       operationCode: 'extract_source',      legacyUsageNo: 9 },
  asset_suggest:      { useCaseCode: 'DATA_RECONCILIATION',   operationCode: 'compare_values',      legacyUsageNo: 3 },
  apply_suggestions:  { useCaseCode: 'DATA_RECONCILIATION',   operationCode: 'compare_values',      legacyUsageNo: 4 },
  enrichissement:     { useCaseCode: 'DATA_RECONCILIATION',   operationCode: 'compare_values',      legacyUsageNo: 5 },
  equipment_link:     { useCaseCode: 'DATA_RECONCILIATION',   operationCode: 'reconcile_links',     legacyUsageNo: 10 },
  search:             { useCaseCode: 'INTELLIGENT_ASSISTANT', operationCode: 'retrieve_data',       legacyUsageNo: 6 },
  intelligent_search: { useCaseCode: 'INTELLIGENT_ASSISTANT', operationCode: 'generate_answer',     legacyUsageNo: 7 },
  agenda_classify:    { useCaseCode: 'AGENDA_INTELLIGENCE',   operationCode: 'classify_event',      legacyUsageNo: 8 },
  ai_instructions:    { useCaseCode: 'AI_GOVERNANCE',         operationCode: 'analyze_instruction', legacyUsageNo: 11 },
};

/**
 * Usage cible d'un identifiant historique, ou `null` s'il est inconnu.
 *
 * `null` plutôt qu'un usage par défaut : un identifiant non prévu doit rester
 * visible comme non rattaché. Le ranger d'office dans l'analyse documentaire
 * fausserait les chiffres exactement là où on les regarde.
 */
export function resolveLegacyUseCase(operationType: string | null | undefined): AiUseCaseCode | null {
  if (!operationType) return null;
  return LEGACY_USAGE_MAPPING[operationType]?.useCaseCode ?? null;
}

export function listLegacyIdentifiers(): string[] {
  return Object.keys(LEGACY_USAGE_MAPPING).sort();
}
