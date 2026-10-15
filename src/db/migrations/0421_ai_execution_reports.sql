-- Migration 0421 — lot 58C : rapport d'exécution T1 / T3 (BO › Exécutions IA).
--
-- Instantané IMMUABLE écrit à la fin de chaque exécution T1 (par document) et
-- T3 (par bien / entité) : étapes et leur résultat, écritures CONFIRMÉES en
-- base (relecture ou RETURNING), données déclarées non persistées et motif,
-- champs examinés non modifiés et motif normalisé, sources consultées,
-- corrélation T1 → T3. Conservé après réanalyse : une nouvelle exécution
-- écrit un NOUVEAU rapport, jamais une mise à jour.
--
-- Volume maîtrisé : aucune copie des contenus déjà stockés au-delà de la
-- valeur écrite. Les textes longs (texte intégral, contenu d'unité, JSON
-- volumineux) sont référencés (table, enregistrement, colonne, empreinte
-- SHA-256, longueur) et relus en direct tant que l'enregistrement d'origine
-- porte la même empreinte ; sinon le BO affiche « non tracé ».
--
-- Rétention : celle des traces IA (tâche `ai-call-diagnostics-purge`).
-- Idempotente.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_execution_reports (
  id                     BIGSERIAL   PRIMARY KEY,
  account_id             INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  treatment              TEXT        NOT NULL,
  -- T3 : ASSET | EQUIPMENT | ROOM ; T1 : DOCUMENT.
  scope                  TEXT        NOT NULL,
  job_id                 INTEGER,
  job_attempt            INTEGER,
  trace_ids              TEXT[]      NOT NULL DEFAULT '{}',
  file_id                INTEGER,
  asset_id               INTEGER,
  target_type            TEXT,
  target_id              INTEGER,
  analysis_run_id        INTEGER,
  extraction_id          INTEGER,
  reconciliation_run_id  INTEGER,
  account_run_id         INTEGER,
  trigger_code           TEXT,
  -- Corrélation : rapport T1 du document source à l'origine de ce passage T3.
  origin_t1_report_id    BIGINT,
  -- Résultat MÉTIER constaté en base : SUCCESS | PARTIAL | FAILED | NO_CHANGE.
  status                 TEXT        NOT NULL,
  -- Rapport lui-même complet ? (false : écriture des lignes en échec, motif dans report_error).
  report_complete        BOOLEAN     NOT NULL DEFAULT TRUE,
  report_error           TEXT,
  counters               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  steps                  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  sources                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  entry_count            INTEGER     NOT NULL DEFAULT 0,
  -- Empreinte des lignes ; un passage identique au précédent (même cible,
  -- aucune écriture) ne recopie pas ses lignes : il désigne le rapport qui
  -- les porte (entries_report_id), protégé de la purge tant qu'il est désigné.
  entries_fingerprint    TEXT,
  entries_report_id      BIGINT,
  schema_version         SMALLINT    NOT NULL DEFAULT 1,
  started_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_execution_reports_treatment_check CHECK (treatment IN ('T1', 'T3')),
  CONSTRAINT ai_execution_reports_status_check CHECK (status IN ('SUCCESS', 'PARTIAL', 'FAILED', 'NO_CHANGE'))
);

CREATE TABLE IF NOT EXISTS ai_execution_report_entries (
  report_id      BIGINT      NOT NULL REFERENCES ai_execution_reports(id) ON DELETE CASCADE,
  seq            INTEGER     NOT NULL,
  account_id     INTEGER     NOT NULL,
  -- T1 : EXTRACTION | FACT | PROJECTION | DECLARED | TABLE | CELL | SOURCE_UNIT | UNRESOLVED | COVERAGE
  --      | OPERATION_CANDIDATE | EVIDENCE | ANALYSIS_RUN | PROPOSAL | DOCUMENT | LINK | RULE
  -- T3 : FIELD | NOT_EXAMINED
  section        TEXT        NOT NULL,
  table_name     TEXT,
  record_id      TEXT,
  column_path    TEXT,
  field_key      TEXT,
  label          TEXT,
  entity_type    TEXT,
  entity_id      INTEGER,
  old_value      JSONB,
  value          JSONB,
  value_type     TEXT,
  value_sha256   TEXT,
  value_chars    INTEGER,
  record_status  TEXT,
  -- WRITTEN | NOT_PERSISTED | FAILED | NOT_WRITTEN | DECIDED_NOT_CONFIRMED | READ_ONLY
  write_result   TEXT        NOT NULL,
  reason_code    TEXT,
  reason         TEXT,
  links          JSONB,
  PRIMARY KEY (report_id, seq)
);

COMMENT ON TABLE ai_execution_reports IS
  'Lot 58C : rapport immuable d''une exécution T1 (document) ou T3 (bien / entité) — écritures confirmées, non-persistances motivées, champs examinés, corrélation T1 → T3. BO › Exécutions IA.';
COMMENT ON TABLE ai_execution_report_entries IS
  'Lot 58C : une ligne par donnée du rapport (emplacement BDD exact, valeur écrite ou référence SHA-256 au contenu existant, résultat réel de l''écriture, motif).';
