-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0230 : assistant Verebona — administration, limiteur partagé, KPI
-- CDC Assistant §6.6, §31.10, §32.3, §32.6, §32.7, CA-30 ; décisions PO du
-- 01/10/2026 D-J1, D-J2, D-J7 (lot 21).
--
--   · verebona_assistant_settings          seuils et interrupteurs administrés
--                                          dans le BO (valeur > variable
--                                          d'environnement > défaut du code) ;
--   · verebona_assistant_setting_requests  double validation (deux
--                                          administrateurs distincts) ;
--   · verebona_rate_limit_counters         compteurs par minute PARTAGÉS entre
--                                          instances (UNLOGGED : perdus sans
--                                          dommage après un arrêt brutal) ;
--   · verebona_usage_events                événements d'usage ANONYMES (§32.3) :
--                                          aucun compte, aucun utilisateur.
--
-- Idempotente. Aucune déclaration Drizzle : tables lues et écrites en SQL
-- direct (services `assistant-settings`, `shared-rate-limit`, `usage-events`).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS verebona_assistant_settings (
  key         TEXT        PRIMARY KEY,
  value       JSONB       NOT NULL,
  updated_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE verebona_assistant_settings IS
  'Seuils et interrupteurs de l''assistant administrés dans le BO (CDC Assistant §6.6, §32.6, CA-30). '
  'Absente pour une clé : variable d''environnement, sinon défaut du code. Historique : admin_audit_log.';

CREATE TABLE IF NOT EXISTS verebona_assistant_setting_requests (
  id            SERIAL      PRIMARY KEY,
  key           TEXT        NOT NULL,
  value         JSONB       NOT NULL,
  requested_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ,
  status        TEXT        NOT NULL DEFAULT 'PENDING',
  CONSTRAINT verebona_assistant_setting_requests_status_check
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'))
);

-- Une seule demande en attente par réglage.
CREATE UNIQUE INDEX IF NOT EXISTS verebona_assistant_setting_requests_pending_uidx
  ON verebona_assistant_setting_requests (key) WHERE status = 'PENDING';

COMMENT ON TABLE verebona_assistant_setting_requests IS
  'Double validation d''un réglage sensible de l''assistant (CDC Assistant §32.7 : modèle preview) : '
  'demandé par un administrateur, appliqué seulement après l''accord d''un SECOND administrateur.';

CREATE UNLOGGED TABLE IF NOT EXISTS verebona_rate_limit_counters (
  bucket_key    TEXT        NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  hits          INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);

-- Table créée par `drizzle-kit push` (déclarée dans `verebona-schema.ts`) :
-- elle serait journalisée. Les compteurs n'ont pas besoin de survivre à un
-- arrêt brutal : UNLOGGED, idempotent.
ALTER TABLE verebona_rate_limit_counters SET UNLOGGED;

CREATE INDEX IF NOT EXISTS verebona_rate_limit_counters_window_idx
  ON verebona_rate_limit_counters (window_start);

COMMENT ON TABLE verebona_rate_limit_counters IS
  'Limiteur de débit de l''assistant partagé entre instances (CDC Assistant §31.10, D-J2) : '
  'compteur par minute et par clé (utilisateur, compte, adresse IP). Purgé au fil de l''eau.';

CREATE TABLE IF NOT EXISTS verebona_usage_events (
  id           BIGSERIAL   PRIMARY KEY,
  event_type   TEXT        NOT NULL,
  action_type  TEXT,
  source_type  TEXT,
  intent       TEXT,
  plan         TEXT,
  value        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT verebona_usage_events_type_check
    CHECK (event_type IN ('ASSISTANT_OPEN', 'ACTION_CLICK', 'SOURCE_OPEN', 'ANSWER_COPY', 'FEEDBACK'))
);

CREATE INDEX IF NOT EXISTS verebona_usage_events_created_idx
  ON verebona_usage_events (created_at);

COMMENT ON TABLE verebona_usage_events IS
  'Indicateurs d''usage de l''assistant (CDC Assistant §32.3, D-J7) : ANONYMES — ni compte ni utilisateur. '
  'Rétention 13 mois (§29.7 agrégats), purge par purge-assistant-logs.';

-- ── Réémission des notifications (CDC 3 §20.3, revue lot 21) ──────────────
-- La ligne d'origine d'une réémission passe à `reemitted` : conservée pour
-- l'historique de l'incident, retirée de la santé des notifications.
ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_status_check;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_status_check
  CHECK (status IN ('pending','processing','sent','partial','failed','cancelled','reemitted'));
