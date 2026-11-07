-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1527 : « À traiter » — fermeture des cartes de STATUT d'événement
-- (lot 113P, ticket #715) : AGENDA-DONE (« Cette échéance a-t-elle été
-- réalisée ? ») et AGENDA-NOT-DONE ne sont plus produites ni résolubles (plus
-- de statut d'événement, plus de demande de confirmation de réalisation).
--
-- Les cartes encore OUVERTES sont closes (motif OBSOLETE), chacune tracée dans
-- `to_process_action_events` (motif EVENT_STATUS_RETIRED). Aucune carte n'est
-- supprimée ; l'historique des cartes déjà tranchées est conservé.
--
-- Idempotente (ne touche que des cartes ouvertes), rejouable.
-- Retour arrière : UPDATE to_process_actions SET resolved_at = NULL,
--   resolution_reason = NULL WHERE id IN (SELECT action_id FROM
--   to_process_action_events WHERE details ->> 'migration' = '1527').
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

WITH closes AS (
  UPDATE to_process_actions
     SET resolved_at = now(), resolution_reason = 'OBSOLETE', updated_at = now()
   WHERE resolved_at IS NULL AND rule_code IN ('AGENDA-DONE', 'AGENDA-NOT-DONE')
  RETURNING id, account_id, target_type, target_id, field_key, rule_code, cycle_number
)
INSERT INTO to_process_action_events (action_id, account_id, event, target_type, target_id, field_key, details, created_at)
SELECT c.id, c.account_id, 'OBSOLETE', c.target_type, c.target_id, c.field_key,
       jsonb_build_object('ruleCode', c.rule_code, 'cycleNumber', c.cycle_number, 'reason', 'EVENT_STATUS_RETIRED', 'migration', '1527'),
       now()
  FROM closes c;
