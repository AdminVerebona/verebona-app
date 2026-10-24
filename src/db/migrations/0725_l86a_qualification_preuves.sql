-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0725 : preuves de qualification HISTORISÉES par couple (lot 86A,
-- CDC Pilotage IA V2 phase P5 : QUAL-01, QUAL-02, QUAL-07..09, DEC-01, DEC-02,
-- R04-R07, R12, R32, R44, R47, R49, R50 ; décisions PO n° 06, 13 et 14).
--
--   · ai_qualification_evidence : UNE ligne par qualification d'un couple
--     (modèle servi, profil effectif, opération, rang, empreintes du prompt,
--     du contrat, du corpus, de l'évaluateur et des capacités, signature
--     globale, environnement, date), verdict (ADMISSIBLE / REFUSED /
--     INCONCLUSIVE), métriques (qualité, délai, concurrence), comparaison à la
--     référence. Jamais réécrite : l'état « obsolète » est CALCULÉ en
--     comparant la signature enregistrée à la signature courante.
--   · ai_qualification_cases : un résultat par cas et par observation (cas du
--     corpus ou rejeu d'une donnée de préproduction), source de la vérité
--     attendue, défauts relevés par catégorie, empreintes des sorties (jamais
--     le contenu), durée, modèle réellement servi.
--
-- Aucune ligne n'est créée pour les configurations existantes : un choix
-- manuel reste « jamais testé » (MIG-02, aucune qualification fictive).
-- Journaux techniques : exclus de l'export de recette, conservés lors d'une
-- restauration (décision 13). Aucune colonne asset_id / file_id. Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_qualification_evidence (
  id                    BIGSERIAL    PRIMARY KEY,
  campaign_id           BIGINT       REFERENCES ai_qualification_campaigns(id) ON DELETE SET NULL,
  environment           TEXT         NOT NULL,
  provider              TEXT         NOT NULL DEFAULT 'gemini',
  treatment             TEXT         NOT NULL,
  operation_code        TEXT         NOT NULL,
  model                 TEXT         NOT NULL,
  served_model          TEXT,
  served_model_version  TEXT,
  rank                  SMALLINT     NOT NULL DEFAULT 0,
  config_version_id     INTEGER,
  config_revision_id    INTEGER,
  role                  TEXT         NOT NULL DEFAULT 'CANDIDATE',
  profile               JSONB        NOT NULL DEFAULT '{}'::jsonb,
  signature             TEXT         NOT NULL,
  prompt_fingerprint    TEXT,
  contract_fingerprint  TEXT,
  corpus_fingerprint    TEXT,
  evaluator_fingerprint TEXT,
  capabilities_sha256   TEXT,
  thresholds_version    TEXT         NOT NULL,
  verdict               TEXT         NOT NULL,
  reasons               JSONB        NOT NULL DEFAULT '[]'::jsonb,
  metrics               JSONB        NOT NULL DEFAULT '{}'::jsonb,
  reference_evidence_id BIGINT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_qualification_evidence_verdict_chk CHECK (verdict IN ('ADMISSIBLE', 'REFUSED', 'INCONCLUSIVE')),
  CONSTRAINT ai_qualification_evidence_role_chk CHECK (role IN ('CANDIDATE', 'REFERENCE'))
);

CREATE INDEX IF NOT EXISTS ai_qualification_evidence_couple_idx
  ON ai_qualification_evidence (environment, operation_code, model, rank, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ai_qualification_evidence_campaign_idx
  ON ai_qualification_evidence (campaign_id);

COMMENT ON TABLE ai_qualification_evidence IS
  'Lot 86A (Pilotage IA V2 P5) : preuve de qualification historisée par couple (modèle servi, profil, opération, rang, empreintes prompt / contrat / corpus / évaluateur / capacités, environnement, date). État obsolète calculé par signature. Lecture : listQualificationEvidence (86B : fichier global).';
COMMENT ON COLUMN ai_qualification_evidence.signature IS
  'SHA-256 des empreintes du couple (QUAL-07) : une preuve ne vaut que pour une signature identique à la signature courante.';

CREATE TABLE IF NOT EXISTS ai_qualification_cases (
  id                BIGSERIAL    PRIMARY KEY,
  evidence_id       BIGINT       NOT NULL REFERENCES ai_qualification_evidence(id) ON DELETE CASCADE,
  case_id           TEXT         NOT NULL,
  source            TEXT         NOT NULL,
  expected_source   TEXT         NOT NULL,
  observation       SMALLINT     NOT NULL DEFAULT 1,
  account_id        INTEGER,
  capture_id        BIGINT,
  mandatory         BOOLEAN      NOT NULL DEFAULT TRUE,
  outcome           TEXT         NOT NULL,
  defects           JSONB        NOT NULL DEFAULT '[]'::jsonb,
  inconclusive_reason TEXT,
  historical_sha256 TEXT,
  observed_sha256   TEXT,
  matches_historical BOOLEAN,
  duration_ms       INTEGER,
  timeout_ms        INTEGER,
  cost_micros       BIGINT,
  served_model      TEXT,
  trace_id          TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_qualification_cases_outcome_chk CHECK (outcome IN ('PASSED', 'FAILED', 'INCONCLUSIVE')),
  CONSTRAINT ai_qualification_cases_source_chk CHECK (source IN ('CORPUS_FIXTURE', 'T1_REFERENCE', 'PREPROD_REPLAY'))
);

CREATE INDEX IF NOT EXISTS ai_qualification_cases_evidence_idx
  ON ai_qualification_cases (evidence_id, case_id, observation);

COMMENT ON TABLE ai_qualification_cases IS
  'Lot 86A : résultat de chaque cas d''une qualification (corpus ou rejeu de donnée de préproduction) : source de la vérité attendue, défauts par catégorie, empreintes des sorties (jamais le contenu), durée, modèle servi.';
