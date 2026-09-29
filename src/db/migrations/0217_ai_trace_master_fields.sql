-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0217 : traces IA — TASK et prompt maître (CDC 15 CFG-02, CFG-05,
-- ARCH-03, DP-05, OBS-CFG). Colonnes ; index dans 0217_*_idx_*.sql.
--
-- « Chaque appel LLM trace treatment, TASK/MODE, masterPromptCode,
-- masterPromptVersion, model et traceId. » Le traitement se déduit de
-- `use_case_code`, le modèle et la trace existent déjà ; manquaient la branche
-- TASK/MODE du prompt maître et la référence de ce prompt.
--
-- NULLABLES : les prompts maîtres arrivent aux lots 12 à 16. Les traces
-- antérieures restent sans valeur — leur en inventer une serait pire.
-- Raisonnement, plafond de sortie, moteur et déclencheur vont dans `metadata`.
--
-- Colonnes NON déclarées dans le schéma Drizzle, volontairement : si ce
-- fichier échouait, les INSERT Drizzle de toutes les traces échoueraient avec
-- lui. Écriture à part, conditionnée par `telemetry/trace-schema.ts`.
--
-- VERROUS (appliquée au démarrage, tables de trace très sollicitées) :
--   · ADD COLUMN nullable sans défaut = modification de catalogue seule, mais
--     sous verrou ACCESS EXCLUSIVE : `lock_timeout` borne l'attente à 5 s
--     (sinon toutes les traces s'empileraient derrière). Dépassé : la
--     migration échoue, est signalée (/api/health) et retentée au prochain
--     démarrage ; les traces continuent sans ces colonnes.
--   · `SET LOCAL` : le fichier est une requête multi-instructions, exécutée
--     par PostgreSQL dans UNE transaction implicite ; le réglage s'arrête avec
--     elle et ne fuit pas sur la connexion du pool.
--   · Index : fichiers séparés, un `CREATE INDEX CONCURRENTLY` chacun (ne peut
--     pas s'exécuter dans une transaction ; une instruction seule par fichier
--     n'en ouvre pas).
--
-- Idempotente : ADD COLUMN IF NOT EXISTS.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_usage_event
  ADD COLUMN IF NOT EXISTS task                  TEXT,
  ADD COLUMN IF NOT EXISTS master_prompt_code    TEXT,
  ADD COLUMN IF NOT EXISTS master_prompt_version TEXT;

ALTER TABLE ai_pipeline_step
  ADD COLUMN IF NOT EXISTS task                  TEXT,
  ADD COLUMN IF NOT EXISTS master_prompt_code    TEXT,
  ADD COLUMN IF NOT EXISTS master_prompt_version TEXT;

COMMENT ON COLUMN ai_usage_event.task IS
  'Branche TASK/MODE du prompt maître imposée par le serveur (CDC 15 DP-05). NULL : appel hors master.';
COMMENT ON COLUMN ai_usage_event.master_prompt_code IS
  'Code du prompt maître du traitement (ex. t1_master), CDC 15 DP-05.';
COMMENT ON COLUMN ai_usage_event.master_prompt_version IS
  'Version du prompt maître appliquée (portée par la version de configuration, D-03).';
