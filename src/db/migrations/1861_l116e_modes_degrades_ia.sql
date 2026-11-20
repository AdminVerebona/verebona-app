-- ─────────────────────────────────────────────────────────────────────────
-- Migration 1861 : IA — trace durable des passages en MODE DÉGRADÉ des
-- protections anti-redondance (lot 116, carte Trello #811, écart P1-C du
-- ticket #596).
--
-- Quand la mémoire des décisions T3 (0856), le cache des réponses ou sa
-- réservation multi-instances (0857) sont absents, désactivés, illisibles ou
-- non inscriptibles, le traitement continue mais peut rappeler le
-- fournisseur. Chaque passage en mode dégradé est compté ici, par jour
-- (Paris), compte, traitement, opération, composant, raison et effet :
--   · component      DECISION_MEMORY | RESPONSE_CACHE | CACHE_RESERVATION |
--                    CONFIG_SIGNATURE ;
--   · reason         DISABLED_BY_CONFIG | MIGRATION_MISSING | READ_FAILED |
--                    WRITE_FAILED | RESERVATION_FAILED | LEASE_RENEWAL_FAILED |
--                    LEASE_LOST | SIGNATURE_UNRESOLVED ;
--   · impact         CALL_WITHOUT_PROTECTION | RESULT_NOT_STORED |
--                    CALL_REFUSED | NO_EXTRA_CALL ;
--   · technical_code code technique borné (SQLSTATE, code d'erreur) — JAMAIS
--                    un message brut, une valeur métier ou un contenu.
-- Lu par le diagnostic du BO (File IA › Supervision T3).
--
-- Table NEUVE : additive, idempotente, aucune reprise de données ; index créé
-- ici (création instantanée). Écriture « au mieux » par l'application : son
-- absence ne bloque aucun traitement (trace dans le journal applicatif).
-- Retour arrière : DROP TABLE IF EXISTS ai_degraded_events.
-- ─────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_degraded_events (
  id             BIGSERIAL   PRIMARY KEY,
  day            DATE        NOT NULL,
  account_id     INTEGER     REFERENCES accounts(id) ON DELETE CASCADE,
  treatment      TEXT        NOT NULL DEFAULT '',
  operation_code TEXT        NOT NULL DEFAULT '',
  component      TEXT        NOT NULL,
  reason         TEXT        NOT NULL,
  impact         TEXT        NOT NULL,
  count          INTEGER     NOT NULL DEFAULT 0,
  technical_code TEXT,
  first_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_degraded_events_count_chk CHECK (count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_degraded_events_key_uidx
  ON ai_degraded_events (day, (COALESCE(account_id, 0)), treatment, operation_code, component, reason, impact);
CREATE INDEX IF NOT EXISTS ai_degraded_events_last_idx ON ai_degraded_events (last_at);
