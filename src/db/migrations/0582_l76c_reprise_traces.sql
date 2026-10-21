-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0582 : « À traiter » — décisions NON TRACÉES rendues visibles et
-- récupérables (lot 76C — ticket « [P1] À traiter — Corriger les défauts
-- résiduels du lot 72C et sécuriser la réévaluation », C8).
--
--   to_process_trace_retries — une ligne par décision métier APPLIQUÉE dont
--     la journalisation (`document_rule_evaluations` 0418/0444/0516,
--     `to_process_decisions` 0516, passages 0560) a échoué : l'enregistrement
--     complet de la décision (`payload` : règle, cible, issue, motif, cartes
--     créées / maintenues / fermées, écriture), l'erreur, la date d'origine.
--     Reprise automatique bornée (tâche planifiée interne
--     `to-process-relevance-reevaluation`) :
--       PENDING     à rejouer (next_attempt_at) ;
--       REPLAYED    trace écrite après coup (diagnostic complet) ;
--       SUPERSEDED  une évaluation plus récente de la même cible et règle a
--                   été tracée depuis — la décision reste consultable ici ;
--       ABANDONED   reprises épuisées : maintenue VISIBLE au BO (jamais un
--                   faux succès), relançable depuis le BO.
--     Rétention : lignes résolues purgées après 400 jours (même tâche).
--
-- Table neuve : aucune réécriture. Le code sonde sa présence (fenêtre de
-- déploiement : l'échec reste remonté au bilan du balayage). Idempotente.
-- Index dans 0582_..._idx_1 et _idx_2 (CONCURRENTLY).
-- Retour arrière : DROP TABLE IF EXISTS to_process_trace_retries (code
-- tolérant : comportement du lot 75, échec remonté au bilan seulement).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS to_process_trace_retries (
  id              BIGSERIAL   PRIMARY KEY,
  account_id      INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- DOCUMENT_RULE (document_rule_evaluations) | FAMILY (to_process_decisions)
  source          TEXT        NOT NULL,
  rule_code       TEXT        NOT NULL,
  target_type     TEXT,
  target_id       INTEGER,
  payload         JSONB       NOT NULL,
  original_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  error           TEXT,
  attempts        INTEGER     NOT NULL DEFAULT 0,
  status          TEXT        NOT NULL DEFAULT 'PENDING',
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT to_process_trace_retries_source_chk CHECK (source IN ('DOCUMENT_RULE', 'FAMILY')),
  CONSTRAINT to_process_trace_retries_status_chk CHECK (status IN ('PENDING', 'REPLAYED', 'SUPERSEDED', 'ABANDONED'))
);

COMMENT ON TABLE to_process_trace_retries IS
  'Lot 76C (C8) : décisions « À traiter » appliquées dont la trace a échoué — visibles au BO, rejouées automatiquement (bornées).';
