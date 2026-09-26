-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0178 : anti-oscillation du disjoncteur IA
-- CDC BO IA WF-09, MOD-013, MOD-014 — revue indépendante lot IA 2.
--
-- La sonde est triviale (aucune donnée utilisateur, MOD-013) : elle peut
-- réussir alors que les vrais appels échouent encore. Le traitement était
-- réactivé, rouvert après cinq échecs complets, sondé trente secondes plus
-- tard, réactivé… Le planning progressif repartait de zéro à chaque ouverture.
--
-- breaker_last_reactivated_at : dernière réactivation PAR SONDE.
-- breaker_reopen_count        : réouvertures consécutives survenues moins
--                               d'une heure après une telle réactivation.
-- Le délai de première sonde et le point de départ du planning en dépendent
-- (circuit-breaker.ts, `reopenPlan`). Une décision manuelle les remet à zéro.
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE ai_treatment_state
  ADD COLUMN IF NOT EXISTS breaker_last_reactivated_at TIMESTAMPTZ;

ALTER TABLE ai_treatment_state
  ADD COLUMN IF NOT EXISTS breaker_reopen_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN ai_treatment_state.breaker_reopen_count IS
  'Réouvertures consécutives du disjoncteur peu après une réactivation par sonde '
  '(anti-oscillation, WF-09). Allonge le délai de la première sonde.';
