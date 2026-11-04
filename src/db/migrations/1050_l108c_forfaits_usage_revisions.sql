-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1050 : dépenses d'usage — révisions DATÉES des forfaits (lot 108C,
-- ticket TCO-646 §E).
--
--   Décision PO : un forfait d'usage est une estimation COMPLÉMENTAIRE des
--   dépenses réelles (complément = max(0, forfait − réel) par catégorie et
--   période échue). Une modification du montant ne doit pas réécrire les
--   périodes closes : la modification crée une NOUVELLE ligne datée
--   (`valid_from` = date d'effet) et termine la précédente la veille ;
--   `revises_budget_id` relie la nouvelle version à la précédente
--   (historique consultable). Aucune donnée existante modifiée.
--
-- Colonne additive, nullable. Idempotente, rejouable. Retour arrière :
-- ALTER TABLE asset_usage_budgets DROP COLUMN IF EXISTS revises_budget_id
-- (le moteur l'ignore si absente).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE asset_usage_budgets ADD COLUMN IF NOT EXISTS revises_budget_id BIGINT
  REFERENCES asset_usage_budgets(id) ON DELETE SET NULL;

COMMENT ON COLUMN asset_usage_budgets.revises_budget_id IS
  'Lot 108C : version précédente de ce forfait (révision datée) — les périodes closes gardent le montant de la version précédente.';

COMMENT ON TABLE asset_usage_budgets IS
  'Lot 54D / 108C : forfaits d''usage (estimations) d''un bien — jamais des Opérations ; ils complètent les dépenses réelles de leur catégorie pour les périodes échues (complément = max(0, forfait − réel)), sans entrer dans le coût documenté.';
