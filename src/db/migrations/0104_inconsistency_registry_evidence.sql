-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0104 : Incohérences adossées aux preuves — CDC §5.4.4
--
-- Le registre doit référencer les preuves de la valeur actuelle ET de la valeur
-- proposée, la règle de priorité appliquée, la nature de la décision
-- (déterministe ou IA), le statut et la résolution. Sans cela, la carte
-- « À arbitrer » du §4.2.9 ne peut pas afficher les documents sources.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE inconsistency_registry ADD COLUMN IF NOT EXISTS current_evidence_ids  JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE inconsistency_registry ADD COLUMN IF NOT EXISTS proposed_evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE inconsistency_registry ADD COLUMN IF NOT EXISTS authority_rule        TEXT;
ALTER TABLE inconsistency_registry ADD COLUMN IF NOT EXISTS decision_mode         TEXT;
ALTER TABLE inconsistency_registry ADD COLUMN IF NOT EXISTS reason_code           TEXT;
ALTER TABLE inconsistency_registry ADD COLUMN IF NOT EXISTS current_origin        TEXT;
ALTER TABLE inconsistency_registry ADD COLUMN IF NOT EXISTS operation_trace_id    UUID;

-- 'deterministic' : tranché par règle ; 'ai_assisted' : arbitrage IA ciblé
ALTER TABLE inconsistency_registry DROP CONSTRAINT IF EXISTS inconsistency_registry_decision_mode_check;
ALTER TABLE inconsistency_registry ADD  CONSTRAINT inconsistency_registry_decision_mode_check
  CHECK (decision_mode IS NULL OR decision_mode IN ('deterministic', 'ai_assisted'));

CREATE INDEX IF NOT EXISTS inconsistency_registry_decision_mode_idx ON inconsistency_registry(decision_mode);
CREATE INDEX IF NOT EXISTS inconsistency_registry_trace_idx         ON inconsistency_registry(operation_trace_id);
