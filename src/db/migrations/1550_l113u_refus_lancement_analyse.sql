-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1550 : journal des REFUS DE LANCEMENT d'une analyse depuis le
-- tiroir du document (lot 113U, carte Trello #720 « Analyse T1 ko »).
--
-- Une ligne par réponse non aboutie de `POST /api/documents/[id]/analyze`
-- (refus de session, d'accès, d'offre, document introuvable, analyse déjà en
-- file, indisponibilité, panne inattendue, échec de l'analyse lancée) et par
-- échec HTTP / réseau constaté côté client sans réponse exploitable
-- (`source = 'client'`, route `POST /api/documents/analyze-launch-reports`).
--
-- `incident_ref` : référence courte (AN-XXXXXXXX) affichée à l'utilisateur
-- quand la cause est inconnue ; le BO la retrouve (BO › File d'attente IA ›
-- Refus de lancement d'analyse). Aucun texte libre reçu, aucun secret, aucun
-- motif technique de l'analyse (celui-ci reste sur le document et dans
-- BO › Exécutions IA) : `detail` ne porte que des codes et des états.
--
-- Pourquoi une table : aucun journal existant ne convient — `user_activity_log`
-- est le journal de sécurité de l'utilisateur (adresse obligatoire, refus sans
-- session impossibles), `ai_usage_event` / `ai_call_diagnostics` décrivent des
-- APPELS au fournisseur (un refus de lancement n'en fait aucun, et fausserait
-- coûts et compteurs), `admin_anomalies` consolide des échecs DÉFINITIFS.
--
-- Rétention : lignes de plus de ANALYSIS_LAUNCH_REFUSAL_RETENTION_DAYS jours
-- (180 par défaut) purgées à l'écriture. Suppression du compte : cascade.
-- Additive, idempotente, rejouable. Retour arrière : DROP TABLE (le code
-- ignore son absence).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_analysis_launch_refusals (
  id                 BIGSERIAL    PRIMARY KEY,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  incident_ref       TEXT         NOT NULL,
  source             TEXT         NOT NULL DEFAULT 'server',
  code               TEXT         NOT NULL,
  category           TEXT         NOT NULL,
  level              TEXT         NOT NULL DEFAULT 'error',
  http_status        INTEGER,
  asset_file_id      INTEGER,
  account_id         INTEGER      REFERENCES accounts(id) ON DELETE CASCADE,
  user_id            INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  client             TEXT,
  app_version        TEXT,
  processing_status  TEXT,
  next_attempt_at    TIMESTAMPTZ,
  detail             JSONB        NOT NULL DEFAULT '{}'::jsonb
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_analysis_launch_refusals_source_chk') THEN
    ALTER TABLE document_analysis_launch_refusals ADD CONSTRAINT document_analysis_launch_refusals_source_chk
      CHECK (source IN ('server', 'client'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_analysis_launch_refusals_level_chk') THEN
    ALTER TABLE document_analysis_launch_refusals ADD CONSTRAINT document_analysis_launch_refusals_level_chk
      CHECK (level IN ('info', 'error'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_analysis_launch_refusals_client_chk') THEN
    ALTER TABLE document_analysis_launch_refusals ADD CONSTRAINT document_analysis_launch_refusals_client_chk
      CHECK (client IS NULL OR client IN ('WEB', 'PWA', 'IOS', 'ANDROID'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS document_analysis_launch_refusals_ref_idx
  ON document_analysis_launch_refusals (incident_ref);
CREATE INDEX IF NOT EXISTS document_analysis_launch_refusals_file_idx
  ON document_analysis_launch_refusals (asset_file_id, created_at DESC);
CREATE INDEX IF NOT EXISTS document_analysis_launch_refusals_account_idx
  ON document_analysis_launch_refusals (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS document_analysis_launch_refusals_created_idx
  ON document_analysis_launch_refusals (created_at);
