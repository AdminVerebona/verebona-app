-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1035 : diagnostics BO durables et reprenables (lot 107G, ticket
-- P0/P1 « Diagnostics BO — réparer les échecs et garantir un ZIP global
-- exhaustif »).
--
-- AUCUNE NOUVELLE TABLE : le suivi des générations d'export existant
-- `admin_export_generations` (0632 lot 81C, 0657 lot 82E, 0692 lot 84D) devient
-- aussi la FILE DURABLE des diagnostics (mode = 'job') — la ligne EST le
-- travail, comme `export_generation` (V12) et `gdpr_exports` (103C) :
--
--   phase           étape atteinte (PLANIFICATION, INVENTAIRE, EXTRACTION,
--                   RELATIONS, CONTROLES, TRACABILITE, MANIFESTE, VALIDATION,
--                   PUBLICATION) ;
--   progress        progression LÉGÈRE (fichiers produits / prévus, lignes,
--                   octets, fichier en cours, mémoire du processus) ;
--   attempt / max_attempts      tentatives (bornées) ;
--   locked_by / locked_until    bail du worker (renouvelé) : un processus
--                   arrêté cesse de le renouveler, la génération est reprise
--                   ou passe FAILED explicite (tentatives épuisées) ;
--   next_attempt_at nouvelle tentative différée (erreur transitoire) ;
--   parent_id       relance manuelle (parenté conservée) ;
--   idempotency_key double clic / requête rejouée : même travail ;
--   request_id      identifiant de corrélation de la demande HTTP ;
--   error_code / error_phase / error_at   code STABLE, étape, horodatage ;
--   attempts_log    historique des tentatives (worker, début, fin, code) ;
--   build_commit    version réellement exécutée par le worker ;
--   cancel_requested, run_started_at, expires_at, purged_at.
--
-- Statuts : QUEUED et CANCELLED s'ajoutent à RUNNING / COMPLETE / PARTIAL /
-- FAILED. Journal technique sans `account_id` (inchangé), aucun contenu
-- exporté conservé ici. Additive et idempotente : rejouable sans effet.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS phase TEXT;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS progress JSONB;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS max_attempts INTEGER;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS locked_by TEXT;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS parent_id UUID;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS error_phase TEXT;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS error_at TIMESTAMPTZ;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS attempts_log JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS build_commit TEXT;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS run_started_at TIMESTAMPTZ;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;

ALTER TABLE admin_export_generations DROP CONSTRAINT IF EXISTS admin_export_generations_status_chk;
ALTER TABLE admin_export_generations ADD CONSTRAINT admin_export_generations_status_chk
  CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETE', 'PARTIAL', 'FAILED', 'CANCELLED'));
