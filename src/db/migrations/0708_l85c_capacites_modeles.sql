-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0708 : capacités des modèles (lot 85C, CDC Pilotage IA V2 P4 :
-- CAT-01, CAT-03, QUAL-06, R45, R46).
--
-- AUCUN SECOND CATALOGUE : le catalogue existant `ai_model_catalog` (0177,
-- 0303 — relevé de l'API Models par la tâche `ai-catalog-sync`) porte
-- désormais la FICHE DE CAPACITÉS effective de chaque modèle listé, figée à
-- chaque passage de la synchronisation quotidienne :
--   capabilities            — paramètres acceptés, niveaux de raisonnement,
--                             défauts, limites, modalités, avec la SOURCE et
--                             la DATE de chaque champ (api / référence / sonde) ;
--   capabilities_sha256     — empreinte comparable (sans les dates) ;
--   capabilities_checked_at — dernier enregistrement ;
--   capabilities_changed_at — dernier CHANGEMENT constaté.
--
-- La qualification existante `ai_model_qualification` (0303) reçoit :
--   rejected_parameters          — paramètres explicitement refusés par le
--                                  modèle lors d'une sonde (incident 4694, R45) ;
--   capabilities_sha256          — fiche sous laquelle la qualification a eu lieu ;
--   requalification_required_at  — « requalification nécessaire », marquée sur
--   requalification_reason         ÉVÉNEMENT (changement de capacités), jamais
--                                  par ancienneté (QUAL-06).
--
-- Tables de configuration IA : exclues de l'export de recette (motif déjà
-- classé dans recette-catalog.ts). Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_model_catalog ADD COLUMN IF NOT EXISTS capabilities            JSONB;
ALTER TABLE ai_model_catalog ADD COLUMN IF NOT EXISTS capabilities_sha256     TEXT;
ALTER TABLE ai_model_catalog ADD COLUMN IF NOT EXISTS capabilities_checked_at TIMESTAMPTZ;
ALTER TABLE ai_model_catalog ADD COLUMN IF NOT EXISTS capabilities_changed_at TIMESTAMPTZ;

COMMENT ON COLUMN ai_model_catalog.capabilities IS
  'Lot 85C — fiche de capacités effective (paramètres acceptés, raisonnement, défauts, limites, modalités ; source et date par champ).';

ALTER TABLE ai_model_qualification ADD COLUMN IF NOT EXISTS rejected_parameters         JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai_model_qualification ADD COLUMN IF NOT EXISTS capabilities_sha256         TEXT;
ALTER TABLE ai_model_qualification ADD COLUMN IF NOT EXISTS requalification_required_at TIMESTAMPTZ;
ALTER TABLE ai_model_qualification ADD COLUMN IF NOT EXISTS requalification_reason      TEXT;

COMMENT ON COLUMN ai_model_qualification.requalification_required_at IS
  'Lot 85C — requalification nécessaire, marquée sur événement (changement de capacités), effacée par la qualification suivante.';
