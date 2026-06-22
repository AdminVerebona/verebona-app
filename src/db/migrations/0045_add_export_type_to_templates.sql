-- Add exportType column to export_templates table
ALTER TABLE export_templates ADD COLUMN export_type TEXT;

-- Add comment for documentation
COMMENT ON COLUMN export_templates.export_type IS 'Type of export document: DOSSIER_VENTE, ASSURANCE_DEVIS, ASSURANCE_SINISTRE, CIL, DOSSIER_COMPLET, REVENTE, SAV_GARANTIE, AUTRE';
