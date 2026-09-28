-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0200 : traces des sondes du disjoncteur IA (coût technique)
-- CDC BO IA MOD-013, OPS-026.
--
-- Les sondes n'appartiennent à aucun compte : `account_id` devient nullable
-- pour les seuls appels TECHNIQUES (is_billable = FALSE). Les appels métier
-- continuent d'être rattachés à un compte (contrainte ci-dessous).
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE ai_usage_event ALTER COLUMN account_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_event_account_or_technical') THEN
    ALTER TABLE ai_usage_event
      ADD CONSTRAINT ai_usage_event_account_or_technical
      CHECK (account_id IS NOT NULL OR is_billable = FALSE);
  END IF;
END $$;

COMMENT ON COLUMN ai_usage_event.account_id IS
  'Compte à l''origine de l''appel. NULL uniquement pour un appel technique non facturable '
  '(sonde du disjoncteur, MOD-013 / OPS-026).';
