-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1486 : registre d'engagements du budget d'amélioration IA (lot 113I,
-- CDC V2 §13, §31, SQL-002, BUD-03..07, FIN-003..007). Service :
-- `src/services/ai/qualification/improvement-budget.ts`.
--
-- Justification (SQL-002) : `ai_usage_event` enregistre le coût APRÈS l'appel et
-- `ai_cost_settings` porte des budgets MÉTIER informatifs (USD, par périmètre) :
-- aucune des deux ne permet de RÉSERVER avant l'appel ni de tenir un engagement
-- au coût inconnu. Une ligne par ESSAI (`attempt_key` unique : jamais deux
-- appels pour la même clé), reliée à la trace fournisseur (`provider_trace_id`,
-- même clé que `ai_usage_event.metadata->>'traceId'`) : les coûts restent ceux
-- de la télémétrie existante, convertis en EUR avec le taux ADMINISTRÉ (devise
-- d'origine, montant d'origine, référence du taux conservés).
--
-- États : RESERVED (avant appel) → SETTLED (coût connu) | RELEASED (jamais
-- envoyé) | UNRECONCILED (envoyé, coût inconnu : reste engagé et bloque).
-- Table technique sans compte. Non exportée vers la production (PRD-04).
-- Additive, idempotente. Retour arrière : DROP TABLE ai_improvement_budget_reservations.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_improvement_budget_reservations (
  id                     BIGSERIAL    PRIMARY KEY,
  environment            TEXT         NOT NULL,
  budget_month           TEXT         NOT NULL,
  phase                  TEXT         NOT NULL,
  purpose                TEXT         NOT NULL,
  attempt_key            TEXT         NOT NULL,
  objective_id           BIGINT,
  campaign_id            BIGINT,
  candidate_version_id   BIGINT,
  treatment              TEXT,
  operation_code         TEXT,
  quoted_currency        TEXT         NOT NULL,
  quoted_max_micros      BIGINT       NOT NULL,
  fx_reference           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  max_eur_micros         BIGINT       NOT NULL,
  state                  TEXT         NOT NULL DEFAULT 'RESERVED',
  settled_eur_micros     BIGINT,
  settled_quoted_micros  BIGINT,
  cost_status            TEXT,
  provider_trace_id      TEXT,
  underestimated         BOOLEAN      NOT NULL DEFAULT FALSE,
  anomaly_resolved_at    TIMESTAMPTZ,
  anomaly_resolved_by    INTEGER,
  anomaly_note           TEXT,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  settled_at             TIMESTAMPTZ,
  CONSTRAINT ai_improvement_budget_phase_chk CHECK (phase IN ('EXPERIMENT', 'MONITOR')),
  CONSTRAINT ai_improvement_budget_purpose_chk CHECK (purpose IN ('GENERATION', 'EXPLORATION', 'VALIDATION', 'JUDGE', 'MONITOR_CHECK')),
  CONSTRAINT ai_improvement_budget_state_chk CHECK (state IN ('RESERVED', 'SETTLED', 'RELEASED', 'UNRECONCILED')),
  CONSTRAINT ai_improvement_budget_amount_chk CHECK (max_eur_micros > 0 AND quoted_max_micros >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_improvement_budget_attempt_uidx ON ai_improvement_budget_reservations (attempt_key);
CREATE INDEX IF NOT EXISTS ai_improvement_budget_month_idx ON ai_improvement_budget_reservations (environment, budget_month, phase, state);
CREATE INDEX IF NOT EXISTS ai_improvement_budget_blocking_idx ON ai_improvement_budget_reservations (environment)
  WHERE state = 'UNRECONCILED' OR (underestimated AND anomaly_resolved_at IS NULL);
CREATE INDEX IF NOT EXISTS ai_improvement_budget_trace_idx ON ai_improvement_budget_reservations (provider_trace_id) WHERE provider_trace_id IS NOT NULL;
COMMENT ON TABLE ai_improvement_budget_reservations IS
  'Lot 113I : engagements du budget d''amélioration IA (100 EUR/mois = 80 expérimentation + 20 surveillance), réservés AVANT chaque essai d''appel, rapprochés des traces. Distinct du budget IA métier.';
