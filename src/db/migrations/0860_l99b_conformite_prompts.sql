-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0860 : mise en conformité automatique des prompts IA (lot 99B,
-- ticket P1 « Mise en conformité automatique des prompts IA en préproduction,
-- avec garantie de non-régression »).
--
--   · ai_prompt_conformity_issues  UNE ligne par incompatibilité (environnement
--                                  × contrat IA du registre) : les occurrences
--                                  identiques sont REGROUPÉES (compteur,
--                                  première / dernière détection) — jamais une
--                                  succession d'alertes redondantes. Statut :
--                                  DETECTED, CORRECTING, TESTING, BLOCKED,
--                                  ACTIVATED, FAILED, ROLLED_BACK, RESOLVED.
--                                  Nature du défaut : PROMPT, CODE ou DATA.
--                                  `context_fingerprint` : empreinte du contexte
--                                  du dernier essai (version active, bloc
--                                  officiel, corpus, seuils, modèle) — un échec
--                                  n'est jamais réessayé sur un contexte
--                                  inchangé.
--   · ai_prompt_conformity_events  journal append-only : détection, candidate
--                                  (diff), qualification (preuves), décision,
--                                  activation, invalidation, rattrapage,
--                                  contrôle post-activation, retour arrière.
--
-- La candidate elle-même n'est PAS stockée ici : c'est une version de prompt
-- maître (`ai_master_prompt_versions`, origine `auto_conformity`, migration
-- 0861) figée dans une candidate automatique de configuration IA
-- (`ai_config_versions` origine `auto`, lot 86A) — aucun mécanisme parallèle.
--
-- Tables techniques sans compte (aucune colonne account_id, asset_id,
-- file_id) ; aucun texte de document, seulement des textes de prompt et des
-- empreintes. Conservées lors d'une restauration (journal de décision).
-- Tables NEUVES : index créés avec elles. Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_prompt_conformity_issues (
  id                           BIGSERIAL    PRIMARY KEY,
  environment                  TEXT         NOT NULL,
  contract_id                  TEXT         NOT NULL,
  treatment                    TEXT         NOT NULL,
  master_prompt_code           TEXT         NOT NULL,
  status                       TEXT         NOT NULL DEFAULT 'DETECTED',
  defect                       TEXT         NOT NULL,
  fault_kind                   TEXT         NOT NULL,
  cause                        TEXT         NOT NULL,
  impact                       TEXT         NOT NULL,
  occurrences                  INTEGER      NOT NULL DEFAULT 1,
  first_detected_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_detected_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_trigger                 TEXT,
  active_prompt_version_id     INTEGER,
  active_prompt_sha256         TEXT,
  context_fingerprint          TEXT,
  candidate_prompt_version_id  INTEGER,
  candidate_config_version_id  INTEGER,
  previous_config_version_id   INTEGER,
  campaign_id                  BIGINT,
  correction                   JSONB        NOT NULL DEFAULT '{}'::jsonb,
  qualification                JSONB        NOT NULL DEFAULT '{}'::jsonb,
  catchup                      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  post_check                   JSONB        NOT NULL DEFAULT '{}'::jsonb,
  refusal_reasons              JSONB        NOT NULL DEFAULT '[]'::jsonb,
  decision                     TEXT,
  activated_at                 TIMESTAMPTZ,
  watch_until                  TIMESTAMPTZ,
  rolled_back_at               TIMESTAMPTZ,
  resolved_at                  TIMESTAMPTZ,
  retry_requested_by           INTEGER,
  retry_requested_at           TIMESTAMPTZ,
  updated_at                   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_prompt_conformity_issues_uq UNIQUE (environment, contract_id),
  CONSTRAINT ai_prompt_conformity_issues_status_chk CHECK (status IN
    ('DETECTED', 'CORRECTING', 'TESTING', 'BLOCKED', 'ACTIVATED', 'FAILED', 'ROLLED_BACK', 'RESOLVED')),
  CONSTRAINT ai_prompt_conformity_issues_defect_chk CHECK (defect IN ('ABSENT', 'OBSOLETE', 'INCOMPLETE', 'INCOMPATIBLE', 'NONE')),
  CONSTRAINT ai_prompt_conformity_issues_fault_chk CHECK (fault_kind IN ('PROMPT', 'CODE', 'DATA', 'NONE'))
);

CREATE INDEX IF NOT EXISTS ai_prompt_conformity_issues_status_idx
  ON ai_prompt_conformity_issues (environment, status, updated_at DESC);

COMMENT ON TABLE ai_prompt_conformity_issues IS
  'Lot 99B : une ligne par incompatibilité entre un contrat IA du code et le prompt maître actif (occurrences regroupées) — cause, impact, correction, qualification, décision, rattrapage, contrôle post-activation.';
COMMENT ON COLUMN ai_prompt_conformity_issues.context_fingerprint IS
  'Empreinte du contexte du dernier essai (version active, bloc officiel, corpus, seuils, modèle) : un essai bloqué, en échec ou annulé n''est jamais rejoué sur un contexte inchangé.';

CREATE TABLE IF NOT EXISTS ai_prompt_conformity_events (
  id            BIGSERIAL    PRIMARY KEY,
  issue_id      BIGINT       NOT NULL REFERENCES ai_prompt_conformity_issues(id) ON DELETE CASCADE,
  environment   TEXT         NOT NULL,
  contract_id   TEXT         NOT NULL,
  kind          TEXT         NOT NULL,
  status_before TEXT,
  status_after  TEXT,
  message       TEXT         NOT NULL,
  payload       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_prompt_conformity_events_issue_idx
  ON ai_prompt_conformity_events (issue_id, created_at DESC, id DESC);

COMMENT ON TABLE ai_prompt_conformity_events IS
  'Lot 99B : journal append-only de la mise en conformité automatique des prompts (détection, candidate et diff, preuves de qualification, décision, activation, invalidation des caches, rattrapage, contrôle post-activation, retour arrière).';
