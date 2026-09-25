-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0146 — Contexte déclencheur des actions « À traiter » (CDC §7.4)
--
-- Une action marquée « Non applicable » ne doit pas réapparaître tant
-- qu'aucun élément nouveau ne le justifie. `upsertAction` ne cherchait que
-- les actions OUVERTES : au balayage suivant, le même problème, avec les
-- mêmes données, recréait aussitôt une action.
--
-- Chaque action porte désormais l'empreinte stable des éléments qui l'ont
-- déclenchée (règle, nature, propositions et preuves, échéance, contexte
-- fourni par le producteur) : même empreinte = rien de nouveau.
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE to_process_actions ADD COLUMN IF NOT EXISTS trigger_context_hash TEXT;
ALTER TABLE to_process_actions ADD COLUMN IF NOT EXISTS trigger_context JSONB;

CREATE INDEX IF NOT EXISTS to_process_actions_problem_resolved_idx
  ON to_process_actions (account_id, target_type, target_id, COALESCE(field_key, relation_key), resolved_at DESC)
  WHERE resolved_at IS NOT NULL;
