-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0638 : statuts fidèles de l'outbox et résultat des lots d'analyse
-- (lot 81E, ticket « E-mails et notifications — écarts résiduels du lot 79C »).
--
--   1. notification_outbox.status accepte deux états terminaux :
--        · skipped — aucun canal n'a envoyé, sans échec (canal supprimé,
--          désactivé au BO, sans destinataire, sans appareil, préférence) :
--          jamais « sent », jamais une anomalie technique ;
--        · grouped — regroupé avec l'incident de référence (`grouped_with_id`).
--      `outcome_reason` porte la cause (codes des livraisons), `grouped_with_id`
--      l'événement qui porte l'incident.
--   2. Statuts historiques corrigés SEULEMENT quand l'état réel est
--      reconstructible :
--        · `cancelled` + `grouped_with:<uuid>` (lot 79C) → `grouped` ;
--        · `sent` dont TOUTES les livraisons tracées sont ignorées (aucune
--          livraison `sent`) → `skipped`, motif = codes des livraisons ;
--        · `sent` sans aucune livraison tracée : non reconstructible, inchangé.
--   3. document_lots : suivi de la notification de RÉSULTAT du lot
--        notification_state     NULL (lot historique : jamais réévalué),
--                               awaiting, notified, absorbed, silent, expired ;
--        notification_user_id   destinataire (demandeur de l'analyse) ;
--        notification_outcome   COMPLETED | PARTIALLY_FAILED | FAILED ;
--        notification_settled_at, notification_absorbed_into (reprise d'un
--        document déjà suivi par un lot antérieur).
--
-- Aucune table nouvelle portant un bien ou un fichier : hors classement des
-- transferts de biens. Idempotente : rejouable sans effet.
-- Retour arrière : l'ancien code n'écrit jamais `skipped` / `grouped` et
-- ignore les colonnes ajoutées.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS outcome_reason text;
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS grouped_with_id uuid;

ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_status_check;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_status_check
  CHECK (status IN ('pending', 'processing', 'sent', 'partial', 'failed', 'cancelled', 'reemitted', 'skipped', 'grouped'));

UPDATE notification_outbox
   SET status = 'grouped',
       grouped_with_id = substring(last_error FROM '^grouped_with:([0-9a-f-]{36})$')::uuid,
       outcome_reason = 'grouped_incident'
 WHERE status = 'cancelled'
   AND last_error ~ '^grouped_with:[0-9a-f-]{36}$';

UPDATE notification_outbox o
   SET status = 'skipped',
       outcome_reason = left(COALESCE((
         SELECT string_agg(DISTINCT COALESCE(d.last_error_code, d.status), ',' ORDER BY COALESCE(d.last_error_code, d.status))
           FROM notification_deliveries d WHERE d.outbox_id = o.id), 'no_channel'), 200)
 WHERE o.status = 'sent'
   AND EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.outbox_id = o.id)
   AND NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.outbox_id = o.id AND d.status IN ('sent', 'failed'));

ALTER TABLE document_lots ADD COLUMN IF NOT EXISTS notification_state text;
ALTER TABLE document_lots ADD COLUMN IF NOT EXISTS notification_user_id integer REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE document_lots ADD COLUMN IF NOT EXISTS notification_outcome text;
ALTER TABLE document_lots ADD COLUMN IF NOT EXISTS notification_settled_at timestamptz;
ALTER TABLE document_lots ADD COLUMN IF NOT EXISTS notification_absorbed_into integer;

ALTER TABLE document_lots DROP CONSTRAINT IF EXISTS document_lots_notification_state_check;
ALTER TABLE document_lots ADD CONSTRAINT document_lots_notification_state_check
  CHECK (notification_state IS NULL OR notification_state IN ('awaiting', 'notified', 'absorbed', 'silent', 'expired'));
