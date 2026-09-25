-- =============================================================================
-- 0155 — Commandes métier exécutées depuis l'assistant, après confirmation.
--
-- Cycle : demande → préparation → prévisualisation → confirmation →
-- exécution → résultat. Le plan est FIGÉ à la préparation : ses actions sont
-- conservées telles qu'affichées (texte exact, `actions_payload`) avec leur
-- empreinte ; la confirmation ne transporte que l'identifiant du plan, jamais
-- de paramètres.
--
-- verebona_command_events trace chaque étape (préparation, confirmation,
-- refus, annulation, exécution, résultat par action).
-- =============================================================================
CREATE TABLE IF NOT EXISTS verebona_command_plans (
  plan_id          TEXT PRIMARY KEY,
  account_id       INTEGER     NOT NULL,
  user_id          INTEGER     NOT NULL,
  conversation_id  INTEGER,
  request_id       TEXT,
  status           TEXT        NOT NULL DEFAULT 'PENDING_CONFIRMATION',
  summary          TEXT        NOT NULL,
  actions_payload  TEXT        NOT NULL,
  params_hash      TEXT        NOT NULL,
  results_json     JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  confirmed_at     TIMESTAMPTZ,
  executed_at      TIMESTAMPTZ,
  CONSTRAINT verebona_command_plans_status_check CHECK (status IN (
    'PENDING_CONFIRMATION', 'EXECUTING', 'EXECUTED', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUSED'))
);
CREATE INDEX IF NOT EXISTS verebona_command_plans_owner_idx
  ON verebona_command_plans (account_id, user_id, status);
CREATE INDEX IF NOT EXISTS verebona_command_plans_conv_idx
  ON verebona_command_plans (conversation_id);

CREATE TABLE IF NOT EXISTS verebona_command_events (
  id          SERIAL PRIMARY KEY,
  plan_id     TEXT        NOT NULL,
  account_id  INTEGER     NOT NULL,
  user_id     INTEGER,
  event_type  TEXT        NOT NULL,
  detail_json JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verebona_command_events_plan_idx
  ON verebona_command_events (plan_id, created_at);
