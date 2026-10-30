-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0870 : certification du corpus de qualification IA (lot 100B,
-- ticket #601 « corpus enrichi : 401 scénarios + 15 stress », arbitrages PO
-- A1 — verrou de promotion — et C2 — le corpus #601 est la référence).
--
--   · ai_corpus_oracle_approvals  approbation INDIVIDUELLE d'un oracle (une
--                                 ligne par geste, jamais en masse) : cas du
--                                 manifeste, empreinte EXACTE de l'oracle
--                                 approuvé, sources vérifiées, auteur, date,
--                                 écran (desktop / mobile). Révocation = ligne
--                                 REVOKED (append-only : rien n'est effacé).
--                                 Un oracle modifié a une autre empreinte :
--                                 l'approbation ne s'applique plus.
--   · ai_corpus_case_decisions    rejet / rétablissement d'un cas depuis le BO
--                                 (motif obligatoire) — aucune suppression.
--   · ai_corpus_a1_assessments    journal du verrou A1 à chaque tentative de
--                                 promotion automatique (périmètre, décision,
--                                 manques) : preuve de l'application du verrou.
--   · ai_qualification_cases      + from_cache (réponse servie par le cache,
--                                 jamais une mesure), attempts (essais
--                                 consommés), manifest_case_id (cas du
--                                 manifeste) : coûts réels par campagne / cas /
--                                 modèle, fournisseur vs cache.
--
-- Tables techniques SANS compte (aucune colonne account_id, asset_id,
-- file_id) ; aucune donnée de document. Conservées lors d'une restauration
-- (décisions humaines et journal). Additive et idempotente ; tables neuves :
-- index créés avec elles.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_corpus_oracle_approvals (
  id                    BIGSERIAL    PRIMARY KEY,
  case_id               TEXT         NOT NULL,
  manifest_version      INTEGER      NOT NULL,
  oracle_version        INTEGER,
  oracle_fingerprint    TEXT         NOT NULL,
  decision              TEXT         NOT NULL,
  sources               JSONB        NOT NULL DEFAULT '[]'::jsonb,
  comment               TEXT,
  admin_user_id         INTEGER,
  admin_label           TEXT         NOT NULL,
  channel               TEXT         NOT NULL DEFAULT 'desktop',
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_corpus_oracle_approvals_decision_chk CHECK (decision IN ('APPROVED', 'REVOKED')),
  CONSTRAINT ai_corpus_oracle_approvals_channel_chk CHECK (channel IN ('desktop', 'mobile')),
  CONSTRAINT ai_corpus_oracle_approvals_sources_chk CHECK (decision = 'REVOKED' OR jsonb_array_length(sources) > 0)
);
CREATE INDEX IF NOT EXISTS ai_corpus_oracle_approvals_case_idx ON ai_corpus_oracle_approvals (case_id, created_at DESC, id DESC);
COMMENT ON TABLE ai_corpus_oracle_approvals IS
  'Lot 100B : approbation individuelle d''un oracle du corpus de qualification (qui, quand, sur quelles sources, quelle empreinte). Jamais par import, jamais en masse ; append-only.';

CREATE TABLE IF NOT EXISTS ai_corpus_case_decisions (
  id                    BIGSERIAL    PRIMARY KEY,
  case_id               TEXT         NOT NULL,
  status                TEXT         NOT NULL,
  reason                TEXT         NOT NULL,
  admin_user_id         INTEGER,
  admin_label           TEXT         NOT NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_corpus_case_decisions_status_chk CHECK (status IN ('REJETEE', 'RETABLIE')),
  CONSTRAINT ai_corpus_case_decisions_reason_chk CHECK (length(btrim(reason)) >= 5)
);
CREATE INDEX IF NOT EXISTS ai_corpus_case_decisions_case_idx ON ai_corpus_case_decisions (case_id, created_at DESC, id DESC);
COMMENT ON TABLE ai_corpus_case_decisions IS
  'Lot 100B : rejet ou rétablissement d''un cas du corpus depuis le BO, motif obligatoire (aucune suppression silencieuse).';

CREATE TABLE IF NOT EXISTS ai_corpus_a1_assessments (
  id                    BIGSERIAL    PRIMARY KEY,
  environment           TEXT         NOT NULL,
  context               TEXT         NOT NULL,
  campaign_id           BIGINT,
  candidate_version_id  BIGINT,
  treatments            TEXT[]       NOT NULL DEFAULT '{}',
  allowed               BOOLEAN      NOT NULL,
  rules_version         TEXT         NOT NULL,
  manifest_version      INTEGER,
  blockers              JSONB        NOT NULL DEFAULT '[]'::jsonb,
  summary               JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_corpus_a1_assessments_context_chk CHECK (context IN ('AUTO_CANDIDATE', 'PROMPT_CONFORMITY', 'MANUAL_NOTICE', 'REPORT'))
);
CREATE INDEX IF NOT EXISTS ai_corpus_a1_assessments_created_idx ON ai_corpus_a1_assessments (created_at DESC, id DESC);
COMMENT ON TABLE ai_corpus_a1_assessments IS
  'Lot 100B (arbitrage A1) : décision du verrou de couverture à chaque tentative de promotion automatique en préproduction (périmètre, manques).';

ALTER TABLE ai_qualification_cases ADD COLUMN IF NOT EXISTS from_cache BOOLEAN;
ALTER TABLE ai_qualification_cases ADD COLUMN IF NOT EXISTS attempts SMALLINT;
ALTER TABLE ai_qualification_cases ADD COLUMN IF NOT EXISTS manifest_case_id TEXT;
COMMENT ON COLUMN ai_qualification_cases.from_cache IS
  'Lot 100B : réponse servie par le cache (jamais une mesure, coût fournisseur nul) — distingue coût réel fournisseur et cache.';
