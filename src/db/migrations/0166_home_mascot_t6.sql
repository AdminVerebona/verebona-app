-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0166 : Mascotte d'accueil et traitement T6
-- CDC Verebona « Mascotte d'accueil & T6 » V1 — §11, §14, §16, §17, §19.
--
--  1. T6 devient le sixième traitement du BO IA (BO-004) : usage HOME_MASCOT,
--     contraintes élargies, une ligne T6 dans chaque version de configuration
--     existante (une version couvre tous les traitements).
--  2. Tables propres à la mascotte (GEN-002 : ses seules écritures) :
--     acquittements « C'est fait », cache T6, journal T6, télémétrie.
-- ──────────────────────────────────────────────────────────────────────────────

-- 1.a Usage HOME_MASCOT
ALTER TABLE ai_use_cases DROP CONSTRAINT IF EXISTS ai_use_cases_code_check;
ALTER TABLE ai_use_cases ADD CONSTRAINT ai_use_cases_code_check CHECK (code IN (
  'SOURCE_ANALYSIS', 'DATA_RECONCILIATION', 'INTELLIGENT_ASSISTANT',
  'AGENDA_INTELLIGENCE', 'AI_GOVERNANCE', 'HOME_MASCOT'
));

INSERT INTO ai_use_cases (code, label, purpose, replaces_legacy_usages, active)
VALUES ('HOME_MASCOT', 'Mascotte d''accueil',
        'Formuler naturellement les sujets choisis par le moteur de l''accueil, sans rien décider.',
        '[]'::jsonb, TRUE)
ON CONFLICT (code) DO NOTHING;

-- 1.b Traitement T6
ALTER TABLE ai_config_entries DROP CONSTRAINT IF EXISTS ai_config_entries_treatment_check;
ALTER TABLE ai_config_entries ADD CONSTRAINT ai_config_entries_treatment_check
  CHECK (treatment IN ('T1', 'T2', 'T3', 'T4', 'T5', 'T6'));

ALTER TABLE ai_treatment_state DROP CONSTRAINT IF EXISTS ai_treatment_state_treatment_check;
ALTER TABLE ai_treatment_state ADD CONSTRAINT ai_treatment_state_treatment_check
  CHECK (treatment IN ('T1', 'T2', 'T3', 'T4', 'T5', 'T6'));

-- 1.c Une ligne T6 dans chaque version existante : sans elle, aucune version
-- ne serait promouvable (« une version couvre tous les traitements »). Le
-- prompt administrable de T6 est sa charte de voix (T6-009) ; le contrat de
-- sortie reste dans le code (mascot_t6_v1.txt). Même contenu que
-- src/services/ai/config/t6-defaults.ts ; niveau de raisonnement renseigné,
-- faute de quoi la validation bloquerait toute promotion.
INSERT INTO ai_config_entries (version_id, treatment, prompt, primary_model, fallback_1,
                               reasoning_primary, reasoning_fallback_1, max_output_tokens)
SELECT v.id, 'T6',
$$Charte de voix de la mascotte Verebona.
Tu écris ce que dit la mascotte de l'accueil à l'utilisateur.
- Naturelle, concise, chaleureuse sans excès, proactive.
- Vocabulaire simple ; jamais alarmiste, jamais infantilisante.
- Vouvoiement obligatoire. Aucun emoji.
- Une formulation positive seulement si elle correspond réellement au contexte.
- La personnalité ne prend jamais le dessus sur l'information.$$,
       'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'minimal', 'minimal', 1024
  FROM ai_config_versions v
 WHERE NOT EXISTS (
   SELECT 1 FROM ai_config_entries e WHERE e.version_id = v.id AND e.treatment = 'T6'
 );

-- 2.a « C'est fait » (§16.2) — au niveau du compte (DONE-004).
CREATE TABLE IF NOT EXISTS home_mascot_acknowledgments (
  id                       SERIAL      PRIMARY KEY,
  account_id               INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  occurrence_key           TEXT        NOT NULL,
  rule_code                TEXT        NOT NULL,
  target_type              TEXT,
  target_id                INTEGER,
  cycle_key                TEXT        NOT NULL,
  acknowledged_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_by_user_id  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  undone_at                TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- DATA-001 : un seul acquittement actif par occurrence et par cycle.
CREATE UNIQUE INDEX IF NOT EXISTS home_mascot_ack_active_uidx
  ON home_mascot_acknowledgments (account_id, occurrence_key, cycle_key)
  WHERE undone_at IS NULL;

CREATE INDEX IF NOT EXISTS home_mascot_ack_account_idx
  ON home_mascot_acknowledgments (account_id);

-- 2.b Cache T6 (RUN-003 à RUN-006) : partagé par le compte, clé = contexte
-- canonique + langue + version du prompt + version du schéma. Une génération
-- tardive écrit sous SA clé, jamais sous celle d'un contexte plus récent
-- (RUN-010).
CREATE TABLE IF NOT EXISTS home_mascot_cache (
  account_id      INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cache_key       TEXT        NOT NULL,
  context_hash    TEXT        NOT NULL,
  prompt_version  TEXT        NOT NULL,
  schema_version  TEXT        NOT NULL,
  messages        JSONB       NOT NULL,
  model           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, cache_key)
);

CREATE INDEX IF NOT EXISTS home_mascot_cache_created_idx ON home_mascot_cache (created_at);

-- 2.c Journal T6 (LOG-004, BO-009) : texte produit, contexte transmis, version
-- du prompt, modèle, secours éventuel, latence, statut, coût ; génération
-- affichée ou pré-génération.
CREATE TABLE IF NOT EXISTS home_mascot_generations (
  id              BIGSERIAL   PRIMARY KEY,
  account_id      INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  context_hash    TEXT        NOT NULL,
  mode            TEXT        NOT NULL,
  status          TEXT        NOT NULL,
  prompt_version  TEXT,
  model           TEXT,
  used_fallback_model BOOLEAN NOT NULL DEFAULT FALSE,
  latency_ms      INTEGER,
  cost_micros     INTEGER,
  trace_id        TEXT,
  input_json      JSONB,
  output_json     JSONB,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT home_mascot_generations_mode_check CHECK (mode IN ('display', 'pregen')),
  CONSTRAINT home_mascot_generations_status_check CHECK (status IN (
    'generated', 'cache_hit', 'fallback', 'validation_failed', 'error', 'disabled', 'skipped'
  ))
);

CREATE INDEX IF NOT EXISTS home_mascot_generations_account_idx
  ON home_mascot_generations (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS home_mascot_generations_created_idx
  ON home_mascot_generations (created_at DESC);

-- 2.d Télémétrie produit (LOG-001, LOG-002) : affiché / cliqué / disparu,
-- une exposition au plus par occurrence et par visite.
CREATE TABLE IF NOT EXISTS home_mascot_events (
  id              BIGSERIAL   PRIMARY KEY,
  account_id      INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id         INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  visit_id        TEXT        NOT NULL,
  occurrence_key  TEXT        NOT NULL,
  source_code     TEXT        NOT NULL,
  placement       TEXT        NOT NULL,
  event_type      TEXT        NOT NULL,
  action_id       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT home_mascot_events_type_check CHECK (event_type IN ('displayed', 'clicked', 'disappeared')),
  CONSTRAINT home_mascot_events_placement_check CHECK (placement IN ('subject', 'secondary'))
);

CREATE UNIQUE INDEX IF NOT EXISTS home_mascot_events_displayed_uidx
  ON home_mascot_events (visit_id, occurrence_key)
  WHERE event_type = 'displayed';

CREATE INDEX IF NOT EXISTS home_mascot_events_account_idx
  ON home_mascot_events (account_id, created_at DESC);
