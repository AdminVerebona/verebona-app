-- Migration: add DEVIS to document_types if not already present

INSERT INTO document_types (code, label, description, is_active, display_order, created_at, updated_at)
SELECT 'DEVIS', 'Devis', 'Devis de prestation, estimation de travaux, offre de prix', true, 2, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM document_types WHERE code = 'DEVIS');

-- Shift subsequent types to make room after FACTURE (order 1)
UPDATE document_types SET display_order = 3  WHERE code = 'GARANTIE';
UPDATE document_types SET display_order = 4  WHERE code = 'MANUEL';
UPDATE document_types SET display_order = 5  WHERE code = 'CONTRAT';
UPDATE document_types SET display_order = 6  WHERE code = 'ATTESTATION_ASSURANCE';
UPDATE document_types SET display_order = 7  WHERE code = 'CERTIFICAT';
UPDATE document_types SET display_order = 8  WHERE code = 'PHOTO';
UPDATE document_types SET display_order = 9  WHERE code = 'ACTE_TRANSACTION';
UPDATE document_types SET display_order = 10 WHERE code = 'AUTRE';
