-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0261 : retrait des notifications « quota d'analyses » (lot 26).
--
-- Les notifications ANALYSIS_QUOTA_90 / ANALYSIS_QUOTA_100 (e-mail « Votre
-- quota d'analyses », push, cloche) sont supprimées : elles parlaient
-- d'analyses alors que le quota commercial est un quota de DOCUMENTS, et
-- partaient sur un compteur d'analyses distinct (réanalyses comprises,
-- période d'essai conservée) — un compte à 59 documents sur 150 les recevait.
-- Le catalogue ne connaît plus ces types (src/lib/notifications/catalog.ts).
--
--   · événements encore en file : annulés (sinon le dispatcher les
--     échouerait en « unknown_event_type » et les remonterait en anomalie) ;
--   · modèle d'e-mail `notif_quota` : supprimé (plus référencé).
--
-- L'historique (cloche déjà livrée, journal de livraison) est conservé.
-- Idempotente : UPDATE / DELETE ciblés, rejouables sans effet.
-- Retour arrière : le modèle peut être recréé par la ligne `notif_quota` de
-- la migration 0077 ; les événements annulés n'ont pas à être relancés.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

UPDATE notification_outbox
SET status = 'cancelled',
    last_error = 'type_retire_lot26:quota_analyses',
    processed_at = NOW()
WHERE event_type IN ('ANALYSIS_QUOTA_90', 'ANALYSIS_QUOTA_100')
  AND status IN ('pending', 'processing');

DELETE FROM email_templates WHERE type = 'notif_quota';
