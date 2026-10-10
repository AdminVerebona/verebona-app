-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0291 : contrat RUNTIME des diagnostics d'appel IA (lot 34D,
-- ticket « faire du contrat runtime la source unique de vérité »).
--
-- ai_call_diagnostics (0284) portait le nom, la version et l'empreinte du
-- schéma. S'y ajoutent l'identifiant et la version du CONTRAT runtime, le
-- structured output transmis ou non et l'empreinte du schéma fournisseur
-- DÉRIVÉ — de quoi vérifier, depuis BO › Exécutions IA, quel contrat a été
-- transmis au modèle et lequel a servi à la validation (le détail complet,
-- RUNTIME_CONTRACT_MISMATCH compris, reste dans `diagnostic`).
--
-- Colonnes NULL sans défaut : ALTER sans réécriture. Pas d'index (lecture par
-- trace, déjà indexée en 0284). Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_call_diagnostics ADD COLUMN IF NOT EXISTS contract_id TEXT;
ALTER TABLE ai_call_diagnostics ADD COLUMN IF NOT EXISTS contract_version INTEGER;
ALTER TABLE ai_call_diagnostics ADD COLUMN IF NOT EXISTS structured_output BOOLEAN;
ALTER TABLE ai_call_diagnostics ADD COLUMN IF NOT EXISTS provider_schema_hash TEXT;

COMMENT ON COLUMN ai_call_diagnostics.contract_id IS
  'Lot 34D : contrat runtime de l''appel (T1_ANALYZE_DOCUMENT…), figé pour toute l''exécution (replis et réparation compris).';
