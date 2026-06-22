-- Migration: add PHOTO and ACTE_TRANSACTION to documentTypes if not already present

INSERT INTO "documentTypes" (code, label, description, "isActive", "displayOrder", "createdAt", "updatedAt")
SELECT 'PHOTO', 'Photo', 'Photo ou image du bien immobilier / mobilier', true, 7, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "documentTypes" WHERE code = 'PHOTO');

INSERT INTO "documentTypes" (code, label, description, "isActive", "displayOrder", "createdAt", "updatedAt")
SELECT 'ACTE_TRANSACTION', 'Acte / Transaction', 'Titre de propriété, acte notarié, permis de construire, document administratif', true, 8, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "documentTypes" WHERE code = 'ACTE_TRANSACTION');

-- Shift AUTRE to displayOrder 9
UPDATE "documentTypes" SET "displayOrder" = 9 WHERE code = 'AUTRE';
