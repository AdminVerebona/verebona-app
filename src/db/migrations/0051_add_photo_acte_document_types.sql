-- Migration: ajoute les types PHOTO et ACTE_TRANSACTION s'ils sont absents.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CETTE MIGRATION VISAIT UNE TABLE QUI N'EXISTE PLUS
--
-- Elle écrivait dans `"documentTypes"` — nom camelCase entre guillemets, hérité
-- d'un schéma antérieur. La table s'appelle aujourd'hui `document_types`, avec
-- des colonnes en serpent minuscule, et c'est ce que déclare `schema.ts`.
--
-- L'échec remontait en 42P01, ce qui laissait croire à une table manquante
-- alors qu'il s'agissait d'un nom périmé.
--
-- Le bloc ci-dessous traite les deux cas : les bases historiques qui portent
-- encore l'ancien nom, et celles créées depuis `schema.ts`.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  ancienne BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'documentTypes'
  ) INTO ancienne;

  IF ancienne THEN
    INSERT INTO "documentTypes" (code, label, description, "isActive", "displayOrder", "createdAt", "updatedAt")
    SELECT 'PHOTO', 'Photo', 'Photo ou image du bien immobilier / mobilier', true, 7, NOW(), NOW()
    WHERE NOT EXISTS (SELECT 1 FROM "documentTypes" WHERE code = 'PHOTO');

    INSERT INTO "documentTypes" (code, label, description, "isActive", "displayOrder", "createdAt", "updatedAt")
    SELECT 'ACTE_TRANSACTION', 'Acte / Transaction',
           'Titre de propriété, acte notarié, permis de construire, document administratif',
           true, 8, NOW(), NOW()
    WHERE NOT EXISTS (SELECT 1 FROM "documentTypes" WHERE code = 'ACTE_TRANSACTION');

    UPDATE "documentTypes" SET "displayOrder" = 9 WHERE code = 'AUTRE';

  ELSIF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'document_types'
  ) THEN
    INSERT INTO document_types (code, label, description, is_active, display_order, created_at, updated_at)
    SELECT 'PHOTO', 'Photo', 'Photo ou image du bien immobilier / mobilier', true, 7, NOW(), NOW()
    WHERE NOT EXISTS (SELECT 1 FROM document_types WHERE code = 'PHOTO');

    INSERT INTO document_types (code, label, description, is_active, display_order, created_at, updated_at)
    SELECT 'ACTE_TRANSACTION', 'Acte / Transaction',
           'Titre de propriété, acte notarié, permis de construire, document administratif',
           true, 8, NOW(), NOW()
    WHERE NOT EXISTS (SELECT 1 FROM document_types WHERE code = 'ACTE_TRANSACTION');

    UPDATE document_types SET display_order = 9 WHERE code = 'AUTRE';
  END IF;
END $$;
