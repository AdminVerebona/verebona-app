-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0114 — Origine « catalogue public » pour les tarifs de modèles
--
-- La migration 0111 n'admettait que deux origines : `billing_api` (la grille
-- facturée au compte Google) et `manual` (saisie en administration). Or la
-- clé de facturation n'est pas toujours disponible, et le CDC refonte exige
-- malgré tout des coûts justes — le défaut n°10 vient précisément de tarifs
-- inventés faute de source.
--
-- Une troisième origine est donc introduite : `public_catalog`, alimentée par
-- la grille publique de Google, relevée à la main puis contrôlée contre la
-- page officielle à chaque rafraîchissement.
--
-- Elle est délibérément marquée NON vérifiée (`is_verified = false`) : un
-- tarif public est juste, mais il ne reflète pas d'éventuelles remises
-- négociées et n'est donc pas opposable à la facture. La distinction reste
-- visible en administration.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ai_model_pricing
  DROP CONSTRAINT IF EXISTS ai_model_pricing_source_check;

ALTER TABLE ai_model_pricing
  ADD CONSTRAINT ai_model_pricing_source_check
    CHECK (source IN ('billing_api', 'public_catalog', 'manual'));

COMMENT ON COLUMN ai_model_pricing.source IS
  'billing_api : grille du compte Google (opposable). '
  'public_catalog : grille publique relevée (juste, hors remises). '
  'manual : saisie en administration.';
