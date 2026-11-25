-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1990 : ASSISTANT T2 — valeurs bancaires TRANSITOIRES d'une proposition
-- et journal de purge des données sensibles (carte Trello #843, écart E04).
--
--   · `verebona_command_plan_secrets` : la nouvelle valeur d'IBAN d'une
--     proposition « modifier un fournisseur » n'est plus écrite en clair dans
--     `verebona_command_plans.actions_payload` (la proposition n'en garde que la
--     forme masquée et une référence). Elle est conservée ici, CHIFFRÉE
--     (AES-256-GCM, clé hors base, données associées = proposition + action +
--     champ), le temps de la confirmation, puis PURGÉE (valeur remise à NULL)
--     dès que la proposition est close : confirmée, annulée, expirée, refusée,
--     en échec. Rétention bornée par `expires_at` (échéance de la proposition) :
--     le balayage quotidien purge toute valeur échue, même d'une proposition
--     restée « en cours » après un arrêt du processus.
--     Purge IDEMPOTENTE (rejouée : rien à faire), TRACÉE (date, motif,
--     tentatives, dernier code d'erreur — jamais la valeur) et SUPERVISABLE
--     (reste à purger compté par le balayage, alerte explicite s'il en reste).
--
--   · `verebona_sensitive_purge_log` : journal de chaque purge (valeur
--     bancaire d'une proposition, IBAN masqué dans un message du fil) et de
--     chaque échec de purge : compte, portée, cible, issue, compteurs. AUCUNE
--     valeur sensible, aucun contenu de message.
--
-- Additive, idempotente, rejouable, NON DESTRUCTIVE (aucune colonne existante
-- modifiée, aucune donnée réécrite par la migration). Retour arrière :
-- DROP TABLE verebona_command_plan_secrets, verebona_sensitive_purge_log — le
-- code détecte l'absence (42P01) et REFUSE alors de préparer un changement
-- d'IBAN (jamais de repli sur une valeur en clair dans la proposition).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS verebona_command_plan_secrets (
  id                    BIGSERIAL PRIMARY KEY,
  plan_id               TEXT        NOT NULL,
  account_id            INTEGER     NOT NULL,
  action_id             TEXT        NOT NULL,
  field                 TEXT        NOT NULL,
  sealed_value          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL,
  purged_at             TIMESTAMPTZ,
  purge_reason          TEXT,
  purge_attempts        INTEGER     NOT NULL DEFAULT 0,
  last_purge_error      TEXT,
  last_purge_attempt_at TIMESTAMPTZ,
  CONSTRAINT verebona_command_plan_secrets_uniq UNIQUE (plan_id, action_id, field),
  CONSTRAINT verebona_command_plan_secrets_field_check CHECK (field IN ('iban')),
  -- Une valeur purgée l'est pour de bon : jamais de valeur ET de date de purge à la fois.
  CONSTRAINT verebona_command_plan_secrets_purge_check CHECK (purged_at IS NULL OR sealed_value IS NULL)
);
CREATE INDEX IF NOT EXISTS verebona_command_plan_secrets_pending_idx
  ON verebona_command_plan_secrets (expires_at) WHERE sealed_value IS NOT NULL;
CREATE INDEX IF NOT EXISTS verebona_command_plan_secrets_account_idx
  ON verebona_command_plan_secrets (account_id, plan_id);

COMMENT ON TABLE verebona_command_plan_secrets IS
  'Carte #843 (E04) : valeur bancaire TRANSITOIRE d''une proposition de l''Assistant, chiffrée, purgée dès la clôture de la proposition (jamais dans actions_payload).';
COMMENT ON COLUMN verebona_command_plan_secrets.sealed_value IS
  'Carte #843 (E04) : valeur chiffrée (AES-256-GCM, clé hors base) ; NULL une fois purgée. Jamais journalisée, jamais exportée.';
COMMENT ON COLUMN verebona_command_plan_secrets.last_purge_error IS
  'Carte #843 (E04) : code de la dernière erreur de purge (jamais la valeur).';

CREATE TABLE IF NOT EXISTS verebona_sensitive_purge_log (
  id          BIGSERIAL PRIMARY KEY,
  account_id  INTEGER,
  scope       TEXT        NOT NULL,
  target_id   TEXT,
  outcome     TEXT        NOT NULL,
  detail_json JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT verebona_sensitive_purge_log_scope_check CHECK (scope IN ('PLAN_SECRET', 'MESSAGE', 'PLAN_PAYLOAD', 'SWEEP')),
  CONSTRAINT verebona_sensitive_purge_log_outcome_check CHECK (outcome IN ('PURGED', 'MASKED', 'NOTHING_TO_DO', 'FAILED', 'BACKLOG'))
);
CREATE INDEX IF NOT EXISTS verebona_sensitive_purge_log_account_idx ON verebona_sensitive_purge_log (account_id, created_at);
CREATE INDEX IF NOT EXISTS verebona_sensitive_purge_log_failed_idx ON verebona_sensitive_purge_log (created_at) WHERE outcome IN ('FAILED', 'BACKLOG');

COMMENT ON TABLE verebona_sensitive_purge_log IS
  'Carte #843 (E04) : journal des purges de données sensibles de l''Assistant (valeurs bancaires des propositions, IBAN des messages) et de leurs échecs — aucune valeur.';

-- ── Carte #843 (E11) : instrumentation NON SENSIBLE des appels T2 au modèle ─────────────────────────────────
-- Version de prompt SERVIE par la passerelle, source (BO_VERSION, BO_CONFIG, REPO_FILE, UNKNOWN ; « :DRIFT » si la
-- version servie diffère de la version résolue), empreinte SHA-256 (16 caractères) du TEXTE effectif du prompt et
-- SHA du build servi. Jamais le texte du prompt. NULLABLES, sans défaut, sans reprise : les exécutions antérieures
-- restent NULL (« non instrumentée »), aucune valeur n'est inventée.
DO $$
BEGIN
  IF to_regclass('verebona_ai_runs') IS NOT NULL THEN
    ALTER TABLE verebona_ai_runs ADD COLUMN IF NOT EXISTS served_prompt_version TEXT;
    ALTER TABLE verebona_ai_runs ADD COLUMN IF NOT EXISTS prompt_source TEXT;
    ALTER TABLE verebona_ai_runs ADD COLUMN IF NOT EXISTS prompt_text_fingerprint TEXT;
    ALTER TABLE verebona_ai_runs ADD COLUMN IF NOT EXISTS app_commit TEXT;
    COMMENT ON COLUMN verebona_ai_runs.prompt_text_fingerprint IS
      'Carte #843 (E11) : SHA-256 (16 caractères) du texte EFFECTIF du prompt maître au moment de l''appel (jamais le texte).';
    COMMENT ON COLUMN verebona_ai_runs.app_commit IS
      'Carte #843 (E11) : SHA du build servi (getBuildIdentity) ; NULL s''il n''est pas connu (jamais inventé).';
  END IF;
END $$;
