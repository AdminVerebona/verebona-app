-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0522 : fin des validations croisées Premium Duo (lot 72D, ticket
-- P0 « compte partagé », décision PO Q11).
--
-- Les deux membres d'un Premium Duo partagent le même compte et les mêmes
-- droits métier : une demande de déplacement ou de suppression soumise à
-- l'autre membre n'a plus d'objet (routes en 410). Les demandes encore EN
-- ATTENTE sont annulées (motif système) et les biens qu'elles verrouillaient
-- sont déverrouillés. Probablement aucune ligne en production
-- (`assets.duo_id` n'était écrit par aucun code).
--
-- Rien n'est supprimé : tables, colonnes `assets.duo_id` / `lock_state` et
-- historique sont conservés jusqu'à la contraction (lot ultérieur). Chaque
-- écriture est tracée dans `duo_shared_account_journal` (0521, run_id fixe de
-- cette migration, état avant / après) : retour arrière possible depuis le
-- journal. Idempotente : une seconde passe ne trouve plus rien en attente.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

WITH c AS (
  UPDATE asset_move_requests
     SET status = 'CANCELLED', resolved_at = now(), resolved_by_type = 'SYSTEM'
   WHERE status = 'PENDING'
  RETURNING id, asset_id
)
INSERT INTO duo_shared_account_journal (run_id, action, entity, entity_id, before, after)
SELECT '72d00522-0000-4000-8000-000000000522'::uuid, 'CROSS_REQUEST_CANCELLED', 'asset_move_request', c.id,
       jsonb_build_object('status', 'PENDING', 'asset_id', c.asset_id), jsonb_build_object('status', 'CANCELLED')
  FROM c;

WITH c AS (
  UPDATE asset_delete_requests
     SET status = 'CANCELLED', resolved_at = now(), resolved_by_type = 'SYSTEM'
   WHERE status = 'PENDING'
  RETURNING id, asset_id
)
INSERT INTO duo_shared_account_journal (run_id, action, entity, entity_id, before, after)
SELECT '72d00522-0000-4000-8000-000000000522'::uuid, 'CROSS_REQUEST_CANCELLED', 'asset_delete_request', c.id,
       jsonb_build_object('status', 'PENDING', 'asset_id', c.asset_id), jsonb_build_object('status', 'CANCELLED')
  FROM c;

WITH avant AS (
  SELECT a.id, a.lock_state
    FROM assets a
   WHERE a.lock_state IN ('PENDING_MOVE', 'PENDING_DELETE')
     AND NOT EXISTS (SELECT 1 FROM asset_move_requests r WHERE r.asset_id = a.id AND r.status = 'PENDING')
     AND NOT EXISTS (SELECT 1 FROM asset_delete_requests r WHERE r.asset_id = a.id AND r.status = 'PENDING')
), u AS (
  UPDATE assets a SET lock_state = 'NONE', updated_at = now()
    FROM avant
   WHERE a.id = avant.id
  RETURNING a.id, a.account_id, avant.lock_state AS ancien
)
INSERT INTO duo_shared_account_journal (run_id, action, entity, entity_id, account_id, before, after)
SELECT '72d00522-0000-4000-8000-000000000522'::uuid, 'ASSET_UNLOCKED', 'asset', u.id, u.account_id,
       jsonb_build_object('lock_state', u.ancien), jsonb_build_object('lock_state', 'NONE')
  FROM u;
