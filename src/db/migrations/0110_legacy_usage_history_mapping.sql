-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0110 : Rattachement des historiques aux cinq usages cibles
-- CDC §9.7 — « Migrer les historiques vers les cinq identifiants, sans
-- réécrire les événements passés. »
--
-- PRINCIPE : les lignes existantes ne sont PAS modifiées dans leur substance.
-- On complète seulement la colonne `use_case_code`, de sorte que les tableaux
-- de suivi par usage puissent agréger l'historique sans le falsifier. Le champ
-- `operation_type` d'origine est conservé tel quel : c'est la trace de ce qui
-- s'est réellement passé, et elle ne doit pas être réécrite.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_legacy_usage_mapping (
  legacy_identifier TEXT PRIMARY KEY,
  legacy_usage_no   INTEGER,
  use_case_code     TEXT NOT NULL REFERENCES ai_use_cases(code),
  operation_code    TEXT,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ai_legacy_usage_mapping
  (legacy_identifier, legacy_usage_no, use_case_code, operation_code, note)
VALUES
  ('document_analysis',   1, 'SOURCE_ANALYSIS',       'extract_source',      'analyse documentaire historique'),
  ('detect_groups',       1, 'SOURCE_ANALYSIS',       'group_sources',       'regroupement, devenu étape interne'),
  ('extract_full',        2, 'SOURCE_ANALYSIS',       'extract_source',      'extraction complète'),
  ('web_link_analysis',   9, 'SOURCE_ANALYSIS',       'extract_source',      'pipeline web séparé, fusionné'),
  ('asset_suggest',       3, 'DATA_RECONCILIATION',   'compare_values',      'suggestions à la demande, supprimées'),
  ('apply_suggestions',   4, 'DATA_RECONCILIATION',   'compare_values',      'complétion des champs vides'),
  ('enrichissement',      5, 'DATA_RECONCILIATION',   'compare_values',      'enrichissement et cohérence'),
  ('equipment_link',     10, 'DATA_RECONCILIATION',   'reconcile_links',     'rattachement équipements'),
  ('search',              6, 'INTELLIGENT_ASSISTANT', 'retrieve_data',       'recherche sémantique'),
  ('intelligent_search',  7, 'INTELLIGENT_ASSISTANT', 'generate_answer',     'réponse générative'),
  ('agenda_classify',     8, 'AGENDA_INTELLIGENCE',   'classify_event',      'classification agenda'),
  ('ai_instructions',    11, 'AI_GOVERNANCE',         'analyze_instruction', 'modification de prompts')
ON CONFLICT (legacy_identifier) DO NOTHING;

UPDATE ai_usage_event e
   SET use_case_code = m.use_case_code
  FROM ai_legacy_usage_mapping m
 WHERE e.use_case_code IS NULL
   AND e.operation_type = m.legacy_identifier;

UPDATE ai_operation o
   SET use_case_code = m.use_case_code
  FROM ai_legacy_usage_mapping m
 WHERE o.use_case_code IS NULL
   AND o.operation_category = m.legacy_identifier;

-- Les lignes restées sans correspondance sont rattachées à l'analyse, qui était
-- l'usage majoritaire, ET SIGNALÉES comme incertaines : un audit doit pouvoir
-- distinguer un rattachement établi d'un rattachement par défaut.
UPDATE ai_usage_event
   SET use_case_code = 'SOURCE_ANALYSIS',
       metadata = COALESCE(metadata, '{}'::jsonb) || '{"legacyMappingUncertain": true}'::jsonb
 WHERE use_case_code IS NULL;

UPDATE ai_operation
   SET use_case_code = 'SOURCE_ANALYSIS'
 WHERE use_case_code IS NULL;
