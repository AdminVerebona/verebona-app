-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0106 : Gouvernance des prompts — CDC §4.5
--
-- Les prompts deviennent des DONNÉES VERSIONNÉES, et non plus des fichiers lus
-- au moment de l'appel. C'est la seule implémentation possible sur Scalingo, où
-- le système de fichiers d'un conteneur est éphémère et non partagé entre
-- instances : les `writeFileSync` de l'ancienne route d'administration étaient
-- perdus au redéploiement et invisibles des autres instances.
--
-- Les fichiers `.txt` du dépôt restent la source d'amorçage et la trace en
-- revue de code.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_prompt_versions (
  id            SERIAL PRIMARY KEY,
  prompt_code   TEXT        NOT NULL,
  version       TEXT        NOT NULL,
  content       TEXT        NOT NULL,
  content_hash  TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'CANDIDATE',
  created_by    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at  TIMESTAMPTZ,
  activated_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT ai_prompt_versions_status_check
    CHECK (status IN ('CANDIDATE', 'ACTIVE', 'SUPERSEDED', 'ROLLED_BACK'))
);

-- ⚠️ CONTRAINTE STRUCTURANTE : une seule version active par prompt, garantie
-- par la base et non par le code applicatif. Sur un hébergement à plusieurs
-- instances, une garantie applicative ne tiendrait pas.
CREATE UNIQUE INDEX IF NOT EXISTS ai_prompt_versions_single_active_idx
  ON ai_prompt_versions(prompt_code) WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS ai_prompt_versions_code_version_idx
  ON ai_prompt_versions(prompt_code, version);

CREATE INDEX IF NOT EXISTS ai_prompt_versions_lookup_idx
  ON ai_prompt_versions(prompt_code, status);

-- ── Demandes de modification ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_prompt_change_requests (
  id                   SERIAL PRIMARY KEY,
  prompt_code          TEXT        NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'DRAFT',
  instruction          TEXT        NOT NULL,
  impact_analysis      TEXT,
  risks                JSONB       NOT NULL DEFAULT '[]'::jsonb,
  base_version_id      INTEGER     REFERENCES ai_prompt_versions(id) ON DELETE SET NULL,
  candidate_version_id INTEGER     REFERENCES ai_prompt_versions(id) ON DELETE SET NULL,
  created_by           INTEGER     NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Première validation humaine : elle porte sur le diff (§4.5.3)
  approved_by          INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  approved_at          TIMESTAMPTZ,
  -- Seconde validation humaine, DISTINCTE de la première : elle porte sur les tests
  activated_by         INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  activated_at         TIMESTAMPTZ,
  rejected_reason      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ai_prompt_change_requests_status_check CHECK (status IN (
    'DRAFT', 'PROPOSED', 'TO_TEST', 'TEST_FAILED', 'READY_FOR_APPROVAL',
    'ACTIVE', 'REJECTED', 'ROLLED_BACK', 'SUPERSEDED'
  ))
);

CREATE INDEX IF NOT EXISTS ai_prompt_change_requests_prompt_idx
  ON ai_prompt_change_requests(prompt_code, status);
CREATE INDEX IF NOT EXISTS ai_prompt_change_requests_status_idx
  ON ai_prompt_change_requests(status);

-- ── Exécutions de tests ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_prompt_test_runs (
  id                SERIAL PRIMARY KEY,
  change_request_id INTEGER     NOT NULL REFERENCES ai_prompt_change_requests(id) ON DELETE CASCADE,
  passed            BOOLEAN     NOT NULL DEFAULT FALSE,
  checks_json       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ai_prompt_test_runs_request_idx
  ON ai_prompt_test_runs(change_request_id);
