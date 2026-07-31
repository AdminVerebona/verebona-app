-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0120 — Origine `RULE` pour le classement documentaire
--
-- ── POURQUOI UNE QUATRIÈME ORIGINE ────────────────────────────────────────
--
-- Le §8.2 du CDC classement prévoyait trois origines : `AI`, `USER`,
-- `REFERENCE_CORRECTION`. Il en manque une.
--
-- La règle 1 du §4.3 — « type compatible avec une seule catégorie : la
-- catégorie est attribuée automatiquement » — n'est ni une inférence du
-- modèle, ni une correction de l'utilisateur, ni un correctif de référentiel.
-- C'est une DÉDUCTION du référentiel lui-même, déterministe et reproductible.
--
-- Les confondre coûterait cher :
--
--   · marquer `AI` ce qui vient d'une règle fausserait toute mesure de la
--     qualité du modèle — on lui attribuerait des succès qu'il n'a pas
--     produits, et le signal d'échec du §5.2 deviendrait illisible ;
--   · marquer `REFERENCE_CORRECTION` mélangerait une attribution ordinaire
--     avec les correctifs irréversibles du §6.3, qui exigent un aperçu et
--     une trace inaltérable.
--
-- `RULE` dit exactement ce qui s'est passé : le référentiel ne laissait qu'une
-- possibilité, elle a été retenue.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE asset_files DROP CONSTRAINT IF EXISTS asset_files_category_source_check;
ALTER TABLE asset_files
  ADD CONSTRAINT asset_files_category_source_check
    CHECK (category_source IS NULL OR category_source IN
      ('AI', 'USER', 'REFERENCE_CORRECTION', 'RULE'));

ALTER TABLE asset_files DROP CONSTRAINT IF EXISTS asset_files_type_source_check;
ALTER TABLE asset_files
  ADD CONSTRAINT asset_files_type_source_check
    CHECK (type_source IS NULL OR type_source IN
      ('AI', 'USER', 'REFERENCE_CORRECTION', 'RULE'));

COMMENT ON COLUMN asset_files.category_source IS
  'AI | USER | REFERENCE_CORRECTION | RULE. RULE = deduction du referentiel (CDC 5 4.3, regle 1).';
