-- Add exportType column to export_templates table
-- `IF NOT EXISTS` ajouté : la colonne peut déjà exister lorsque le schéma a
-- été créé par `drizzle-kit push` depuis `schema.ts`, ce qui est le mode
-- opératoire de ce projet. Sans lui, la migration échoue en 42701 et bloque
-- la chaîne à chaque démarrage.
ALTER TABLE export_templates ADD COLUMN IF NOT EXISTS export_type TEXT;

-- Add comment for documentation
COMMENT ON COLUMN export_templates.export_type IS 'Type of export document: DOSSIER_VENTE, ASSURANCE_DEVIS, ASSURANCE_SINISTRE, CIL, DOSSIER_COMPLET, REVENTE, SAV_GARANTIE, AUTRE';
