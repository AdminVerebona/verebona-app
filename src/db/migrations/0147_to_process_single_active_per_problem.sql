-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0147 — Une seule action active par problème métier (CDC V2 §7.3)
--
-- L'unicité portait sur compte + objet + champ/relation + NATURE : une
-- action COMPLETE et une action ARBITRATE pouvaient rester ouvertes ensemble
-- sur la même donnée (deux cartes, compteur à 2 pour une seule réponse
-- attendue).
--
-- 1. Rattrapage : pour chaque problème ayant plusieurs actions actives, la
--    plus récente est conservée, les autres fermées en OBSOLETE (historisées).
-- 2. L'index d'unicité ne porte plus sur la nature.
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY account_id, target_type, target_id, COALESCE(field_key, relation_key)
           ORDER BY last_seen_at DESC, id DESC
         ) AS rn
    FROM to_process_actions
   WHERE resolved_at IS NULL
)
UPDATE to_process_actions a
   SET resolved_at = now(), resolution_reason = 'OBSOLETE', updated_at = now()
  FROM ranked r
 WHERE a.id = r.id AND r.rn > 1;

DROP INDEX IF EXISTS to_process_actions_active_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS to_process_actions_active_problem_uidx
  ON to_process_actions (account_id, target_type, target_id, COALESCE(field_key, relation_key))
  WHERE resolved_at IS NULL;
