-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0410 : diagnostic des « À traiter » T3 (lot 57B — ticket P0
-- « T3 — Corriger les À traiter non résolus et fiabiliser les logs »).
--
--   t3_open_action_evaluations (0371) — enrichie : une ligne par carte et par
--       passage T3 global porte désormais le PARCOURS complet de la carte :
--       motif exploitable (`reason_code` : NO_CANDIDATE, INSUFFICIENT_EVIDENCE,
--       AMBIGUOUS, AI_UNAVAILABLE, JOB_PENDING, DEPENDENCY_STALLED,
--       RESOLVER_FAILED, PERSISTENCE_FAILED, USER_DECISION_PROTECTED…),
--       déclencheur, début / fin / durée, dernière étape réussie et étape en
--       échec, job spécialisé délégué (identifiant, statut), sources T1
--       chargées (nombre d'éléments par source) et sources absentes / en
--       échec, origine des candidats, appel IA (opération, traceId, statut,
--       erreur), décision et confiance, écriture tentée et vérifiée en base.
--       Identifiants, codes et compteurs seulement : aucune valeur métier,
--       aucun extrait de document.
--
--   account_reconciliation_runs — `outcome` (SUCCESS, PARTIAL_SUCCESS,
--       BUSINESS_ABSTENTION, TECHNICAL_FAILURE) et `phases_json` (état de
--       CHAQUE phase obligatoire : biens, connaissance ouverte, « À traiter »
--       ouverts, journal — DONE / PARTIAL / FAILED / NOT_RUN, erreur,
--       compteurs). Une phase non exécutée n'est jamais présentée comme une
--       phase exécutée avec zéro résultat.
--
-- Colonnes NULLABLE sans défaut volatil (catalogue seulement, aucune
-- réécriture de table). Index dans 0410_..._idx_1 et _idx_2 (CONCURRENTLY).
-- Le code tolère leur absence (journal réduit aux colonnes 0371, phases dans
-- le résumé du job). Idempotente. Retour arrière : ALTER TABLE … DROP COLUMN
-- IF EXISTS … (code tolérant).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE t3_open_action_evaluations
  ADD COLUMN IF NOT EXISTS reason_code           TEXT,
  ADD COLUMN IF NOT EXISTS trigger_code          TEXT,
  ADD COLUMN IF NOT EXISTS started_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finished_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS duration_ms           INTEGER,
  ADD COLUMN IF NOT EXISTS last_step             TEXT,
  ADD COLUMN IF NOT EXISTS failed_step           TEXT,
  ADD COLUMN IF NOT EXISTS delegated_job_id      INTEGER,
  ADD COLUMN IF NOT EXISTS delegated_job_status  TEXT,
  ADD COLUMN IF NOT EXISTS knowledge_sources     JSONB,
  ADD COLUMN IF NOT EXISTS missing_sources       JSONB,
  ADD COLUMN IF NOT EXISTS candidate_origins     JSONB,
  ADD COLUMN IF NOT EXISTS ai_operation          TEXT,
  ADD COLUMN IF NOT EXISTS ai_trace_id           TEXT,
  ADD COLUMN IF NOT EXISTS ai_status             TEXT,
  ADD COLUMN IF NOT EXISTS ai_error              TEXT,
  ADD COLUMN IF NOT EXISTS decision              TEXT,
  ADD COLUMN IF NOT EXISTS confidence            NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS write_attempted       BOOLEAN,
  ADD COLUMN IF NOT EXISTS write_verified        BOOLEAN;

ALTER TABLE account_reconciliation_runs
  ADD COLUMN IF NOT EXISTS outcome      TEXT,
  ADD COLUMN IF NOT EXISTS phases_json  JSONB;

COMMENT ON COLUMN t3_open_action_evaluations.reason_code IS
  'Lot 57B : motif exploitable de l''issue de la carte (RESOLVED, NO_CANDIDATE, INSUFFICIENT_EVIDENCE, AMBIGUOUS, AI_UNAVAILABLE, JOB_PENDING, DEPENDENCY_STALLED, RESOLVER_FAILED, PERSISTENCE_FAILED, USER_DECISION_PROTECTED, NOT_T3…).';
COMMENT ON COLUMN account_reconciliation_runs.phases_json IS
  'Lot 57B : état de chaque phase obligatoire du passage T3 (DONE / PARTIAL / FAILED / NOT_RUN), erreur et compteurs.';
