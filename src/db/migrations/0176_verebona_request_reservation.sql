-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0176 : réservation des demandes de l'assistant
-- CDC Assistant §6.6, §7.8, §9.7, §27.5, §31.9, CA-22, CA-29, 37.17, 37.20.
--
-- La ligne `verebona_request_runs` est désormais écrite AU DÉBUT du traitement
-- (status = 'pending'), et non plus à la fin : c'est ce qui rend l'annulation
-- effective et permet de refuser un second envoi identique ou une seconde
-- demande simultanée dans le même fil (voir
-- src/services/verebona-assistant/core/request-lifecycle.service.ts).
--
-- 1. Idempotence par utilisateur : un même client_request_id ne peut réserver
--    qu'une demande. Les doublons historiques éventuels (avant cette
--    migration) sont détachés — l'identifiant client est effacé sur les plus
--    anciens — plutôt que supprimés : la trace de coût reste.
-- 2. Recherche de la demande en cours d'un fil (verrou « une seule demande »).
-- ──────────────────────────────────────────────────────────────────────────────

UPDATE verebona_request_runs r
   SET client_request_id = NULL
 WHERE r.client_request_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM verebona_request_runs d
      WHERE d.account_id = r.account_id
        AND d.user_id IS NOT DISTINCT FROM r.user_id
        AND d.client_request_id = r.client_request_id
        AND d.id > r.id
   );

CREATE UNIQUE INDEX IF NOT EXISTS verebona_request_runs_client_request_uidx
  ON verebona_request_runs (account_id, user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS verebona_request_runs_pending_idx
  ON verebona_request_runs (conversation_id, created_at)
  WHERE status = 'pending';
