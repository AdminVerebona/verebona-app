-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0171 : circuit breaker branché au runtime
-- CDC BO IA MOD-007 à MOD-014, OPS-019 à OPS-026, WF-09.
--
-- `ai_treatment_state` portait déjà `model_failures` (compteurs PAR MODÈLE,
-- MOD-007), `next_probe_at` et `probe_attempts`. Il manquait le compteur
-- d'échecs COMPLETS consécutifs PAR TRAITEMENT : c'est lui, et non un échec du
-- principal, qui ouvre le disjoncteur (WF-09 : « un fallback réussi empêche de
-- considérer la demande comme échec complet »).
--
-- Colonne dédiée plutôt qu'une clé réservée dans `model_failures` : ce jsonb
-- est indexé par nom de modèle, et y glisser un compteur d'une autre nature
-- le ferait apparaître comme un « modèle » en alerte.
--
-- `suspended_by_breaker` distingue une suspension automatique (sondée, puis
-- réactivée seule au premier succès — MOD-014) d'un état posé à la main, que
-- les sondes ne doivent jamais rallumer (§4.2).
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE ai_treatment_state
  ADD COLUMN IF NOT EXISTS consecutive_chain_failures INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ai_treatment_state
  ADD COLUMN IF NOT EXISTS suspended_by_breaker BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN ai_treatment_state.consecutive_chain_failures IS
  'Échecs complets consécutifs de la chaîne de modèles (tous modèles en échec). '
  'Remis à zéro au premier succès. Au seuil défini dans le code, le traitement '
  'passe à SUSPENDED sans interrompre les exécutions en cours (MOD-011).';

COMMENT ON COLUMN ai_treatment_state.suspended_by_breaker IS
  'TRUE si la suspension vient du circuit breaker : seules celles-ci sont '
  'sondées et réactivées automatiquement (MOD-013, MOD-014).';
