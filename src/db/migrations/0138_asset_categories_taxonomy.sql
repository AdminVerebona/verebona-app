-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0138 — Familles et catégories de biens (libellés)
--
-- Nouveau classement (lib/asset-taxonomy.ts) :
--   Véhicule   : Voiture ; Moto ; Vélo ; Camping-car ; Bateau ; Camion
--   Immobilier : Maison ; Appartement ; Immeuble ; Terrain ; Garage/box ;
--                Mobil-home ; Local professionnel/commercial
--   Objet      : Tech / IT / Électronique ; Loisir / Sport ; Maison & équipement
--
-- Le schéma ne change pas : la famille reste `assets.category`, la catégorie
-- `assets.subtype` (Immobilier, Véhicule) ou `assets.object_category`
-- (Objet). Seuls deux libellés existants sont renommés, pour que les biens
-- déjà créés apparaissent sous la bonne catégorie :
--   « Garage »           → « Garage/box »
--   « Local commercial » → « Local professionnel/commercial »
-- plus les graphies approchantes déjà rencontrées en saisie libre.
--
-- Les autres valeurs (dont « Studio », hors liste) sont laissées intactes :
-- l'interface les affiche comme valeur courante, sans les effacer.
-- Rejouable sans effet.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE assets
SET subtype = 'Garage/box', updated_at = now()
WHERE category = 'IMMOBILIER'
  AND lower(btrim(subtype)) IN ('garage', 'box', 'garage / box', 'garage-box');

UPDATE assets
SET subtype = 'Local professionnel/commercial', updated_at = now()
WHERE category = 'IMMOBILIER'
  AND lower(btrim(subtype)) IN ('local commercial', 'local professionnel', 'local professionnel / commercial');

UPDATE assets
SET subtype = 'Mobil-home', updated_at = now()
WHERE category = 'IMMOBILIER'
  AND lower(btrim(subtype)) IN ('mobil home', 'mobilhome', 'mobile home', 'mobile-home');

UPDATE assets
SET subtype = 'Camping-car', updated_at = now()
WHERE category = 'VEHICULE'
  AND lower(btrim(subtype)) IN ('camping car', 'campingcar');

-- Référentiel d'administration (asset_type_subcategories) : mêmes libellés,
-- et catégories manquantes. Aucune suppression : une sous-catégorie peut être
-- référencée par `assets.asset_type_subcategory_id`.
UPDATE asset_type_subcategories SET label = 'Garage/box'
WHERE code = 'GARAGE' AND label = 'Garage';
UPDATE asset_type_subcategories SET label = 'Local professionnel/commercial'
WHERE code = 'LOCAL_COMMERCIAL' AND label = 'Local commercial';

INSERT INTO asset_type_subcategories (asset_type_id, code, label, icon, display_order, is_enabled, created_at, updated_at)
SELECT t.id, v.code, v.label, v.icon, v.display_order, true, now(), now()
FROM asset_types t
JOIN (VALUES
  ('IMMOBILIER', 'IMMEUBLE',    'Immeuble',    'Hotel',    7),
  ('IMMOBILIER', 'MOBIL_HOME',  'Mobil-home',  'Caravan',  8),
  ('VEHICULE',   'CAMPING_CAR', 'Camping-car', 'Caravan',  5),
  ('VEHICULE',   'BATEAU',      'Bateau',      'Sailboat', 6)
) AS v(type_code, code, label, icon, display_order) ON v.type_code = t.code
WHERE NOT EXISTS (
  -- `code` est unique sur toute la table.
  SELECT 1 FROM asset_type_subcategories s WHERE s.code = v.code
);
