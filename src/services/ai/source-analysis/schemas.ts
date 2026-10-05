/**
 * Schémas de sortie des opérations d'analyse — CDC §5.3.
 *
 * Toute sortie modèle est validée avant la moindre persistance. Les
 * identifiants d'entités acceptés par le schéma restent NON VÉRIFIÉS : leur
 * existence réelle est contrôlée par `identifier-verifier.ts` (§4.1.7).
 *
 * Lot 16b-3 : les schémas des opérations d'étapes supprimées (`group_sources`,
 * `classify_document`, `classify_rubric`, `extract_source`,
 * `identify_entities`, `propose_links`) sont retirés avec elles ; seul le
 * contrat du prompt maître T1 demeure.
 */
// ── Prompt maître T1 (CDC 15 §23, PM-T1, lot 12) ────────────────────────────
//
// Point d'entrée unique pour les consommateurs : les schémas des deux branches
// (GROUP_UPLOAD / ANALYZE_DOCUMENT) sont DÉFINIS dans `master/t1-contract.ts`
// et seulement réexportés ici — jamais dupliqués (une seconde définition
// finirait par diverger du prompt).
export {
  T1_MASTER_PROMPT_CODE,
  T1_TASKS,
  T1_PROVENANCES,
  T1_TARGET_TYPES,
  T1_EVENT_NATURES,
  T1_VALUE_TYPES,
  t1Evidence,
  t1VisualEvidence,
  t1Target,
  t1Recurrence,
  t1SemanticEvent,
  t1Fact,
  t1Table,
  T1GroupUploadOutput,
  T1AnalyzeDocumentOutput,
  T1MasterOutput,
  t1OutputSchemaFor,
} from './master/t1-contract';
