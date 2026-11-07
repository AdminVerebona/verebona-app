-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1535 : vérifications de l'ENVOI DE FICHIER au fournisseur IA
-- (lot 113R, carte Trello #717 « [P1] T1 — Résoudre le 403 Files API,
-- conserver sa cause et reprendre automatiquement les analyses »).
--
-- Chaque vérification d'envoi est conservée :
--   · `admin_test`  : action BO « Tester l'envoi d'un fichier au fournisseur »
--                     (petit fichier de test sans donnée utilisateur, clé et
--                     configuration EFFECTIVES) ;
--   · `auto_probe`  : sonde automatique de rétablissement, lancée par la
--                     reprise serveur tant que des documents attendent la fin
--                     d'un incident d'envoi (au plus une toutes les 15 min).
-- La réponse du fournisseur est conservée SANS SECRET (clé, URL signée et
-- en-têtes sensibles retirés avant écriture) : statut HTTP, statut et code
-- fournisseur, message, raison, détails, identifiant de requête, extrait
-- borné du corps (`failure`, format transfer-v1). `config` : configuration
-- effective (source de la clé par NOM — jamais sa valeur —, endpoint,
-- version d'API).
--
-- Rétention explicite : lignes de plus de AI_TRANSFER_CHECK_RETENTION_DAYS
-- jours (365 par défaut) purgées par la reprise serveur. Les échecs RÉELS de
-- chaque tentative d'analyse restent avec l'appel (`ai_usage_event.metadata
-- .transfer`, `ai_call_diagnostics.diagnostic.transfer`), selon la politique
-- de conservation des diagnostics IA (décisions PO 01 et 10 du 22/10).
--
-- Aucune donnée métier, aucun compte client. Additive, idempotente,
-- rejouable. Retour arrière : DROP TABLE (le code ignore son absence).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_provider_transfer_checks (
  id                BIGSERIAL   PRIMARY KEY,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  origin            TEXT        NOT NULL,
  triggered_by      INTEGER,
  provider          TEXT        NOT NULL DEFAULT 'gemini',
  ok                BOOLEAN     NOT NULL,
  step              TEXT,
  endpoint          TEXT,
  http_status       INTEGER,
  provider_status   TEXT,
  provider_code     INTEGER,
  provider_message  TEXT,
  provider_reason   TEXT,
  request_id        TEXT,
  provider_detail   TEXT,
  failure           JSONB,
  config            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  duration_ms       INTEGER,
  file_state        TEXT,
  cleanup_ok        BOOLEAN
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_provider_transfer_checks_origin_chk') THEN
    ALTER TABLE ai_provider_transfer_checks ADD CONSTRAINT ai_provider_transfer_checks_origin_chk
      CHECK (origin IN ('admin_test', 'auto_probe'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_provider_transfer_checks_created_idx ON ai_provider_transfer_checks (created_at DESC);

COMMENT ON TABLE ai_provider_transfer_checks IS
  'Lot 113R : vérifications de l''envoi de fichier au fournisseur IA (test BO, sonde de rétablissement) — réponse fournisseur sans secret.';
