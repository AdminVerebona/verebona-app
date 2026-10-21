-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0581 : « À traiter » — campagne de réévaluation : reprise
-- persistante des erreurs et bilan exact (lot 76C — ticket « [P1] À traiter —
-- Corriger les défauts résiduels du lot 72C et sécuriser la réévaluation », C7).
--
--   to_process_relevance_campaign_items (0445, 0517)
--     attempts         nombre de traitements de l'élément (1 au premier passage) ;
--     first_error      première erreur constatée (jamais effacée : historique) ;
--     last_error       dernière erreur (NULL : repris avec succès) ;
--     retry_after      prochaine reprise automatique d'un élément en erreur ;
--     retried_at       date de la dernière reprise ;
--     final_outcome    issue APRÈS reprise (l'issue initiale `outcome` reste
--                      lisible pour l'historique : ERROR puis KEPT…).
--   to_process_relevance_campaigns (0445, 0517)
--     traversal_finished_at  fin du PARCOURS (cartes + décisions) — distincte
--                            de la fin de la campagne : la campagne n'est
--                            « DONE » que sans erreur non traitée ;
--     scope            périmètre explicite (familles, règles, phases) ;
--     retries          reprises effectuées ;
--     status           + 'DONE_WITH_ERRORS' : parcours terminé, erreurs
--                      maintenues comme BLOQUANTES après les reprises bornées
--                      (visibles au BO, relançables).
--
-- Colonnes NULLables ou à défaut constant : aucune réécriture de table. Le code
-- sonde leur présence (fenêtre de déploiement : comportement du lot 75).
-- Idempotente. Index dans 0581_..._idx_1 (CONCURRENTLY).
-- Retour arrière : ALTER TABLE ... DROP COLUMN IF EXISTS (colonnes ci-dessus) ;
-- UPDATE to_process_relevance_campaigns SET status = 'DONE' WHERE status =
-- 'DONE_WITH_ERRORS' ; contrainte de statut du lot 61 rétablie.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('to_process_relevance_campaign_items') IS NOT NULL THEN
    ALTER TABLE to_process_relevance_campaign_items
      ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS first_error TEXT,
      ADD COLUMN IF NOT EXISTS last_error TEXT,
      ADD COLUMN IF NOT EXISTS retry_after TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS retried_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS final_outcome TEXT;
    COMMENT ON COLUMN to_process_relevance_campaign_items.final_outcome IS
      'Lot 76C (C7) : issue après reprise d''un élément en erreur (outcome garde l''issue initiale).';
  END IF;
  IF to_regclass('to_process_relevance_campaigns') IS NOT NULL THEN
    ALTER TABLE to_process_relevance_campaigns
      ADD COLUMN IF NOT EXISTS traversal_finished_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS scope JSONB,
      ADD COLUMN IF NOT EXISTS retries INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE to_process_relevance_campaigns DROP CONSTRAINT IF EXISTS to_process_relevance_campaigns_status_chk;
    ALTER TABLE to_process_relevance_campaigns ADD CONSTRAINT to_process_relevance_campaigns_status_chk
      CHECK (status IN ('RUNNING', 'DONE', 'DONE_WITH_ERRORS', 'ERROR'));
  END IF;
END $$;
