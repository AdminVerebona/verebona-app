-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0760 : données de NOMMAGE persistées des documents (lot 87D, ticket
-- P1 « Documents — Uniformiser les titres des factures périodiques et
-- fiabiliser leur affichage dans toute l'application »).
--
-- Écrites UNIQUEMENT par le service de nommage centralisé
-- (`src/services/documents/document-title.service.ts`, `ensureBusinessTitle`) —
-- fin d'analyse T1, connaissance T3, contrôle de cohérence COH-DOC-TITLES :
--   title_basis          données utilisées par le titre, avec leur provenance :
--                        période réellement facturée (`billedPeriod`, source
--                        T1), mois de rattachement principal décidé par l'IA
--                        (`principalMonth`, NULL tant que le contrat T1 ne le
--                        fournit pas — demande 87D-mois-principal-factures),
--                        date d'émission, références de facture (recherchables
--                        par la recherche globale), fournisseur, nature,
--                        convention, période affichée, discriminant ;
--   title_convention     convention appliquée au titre automatique
--                        ('PERIODIC' : « Facture Homiris — Février 2026 »),
--                        NULL sinon. Un document sous convention n'est plus
--                        nommé par l'harmonisation T3 (DOCUMENT_NAMING) ;
--   title_canonical_key  clé du groupe canonique (nature | fournisseur |
--                        période) : désambiguïsation déterministe de deux
--                        factures distinctes de même période.
-- Le titre utilisateur (title_source = 'USER') n'est jamais réécrit ; ses
-- données de nommage sont tenues à jour (recherche, groupe canonique).
--
-- Colonnes NON déclarées dans Drizzle (même choix que 0351 / 0744) : lues et
-- écrites en SQL par le service, la recherche globale et le contrôle.
-- Additive, idempotente, aucune reprise de données ici : le stock est repris
-- par le contrôle de cohérence COH-DOC-TITLES (campagne quotidienne, contrôles
-- ciblés), avec la version 3 des règles de titre. Colonnes NULL sans défaut :
-- aucune réécriture de table. Contrainte posée NOT VALID (lignes existantes
-- NULL) puis validée (SHARE UPDATE EXCLUSIVE, n'empêche pas les écritures).
-- Retour arrière : ALTER TABLE asset_files DROP COLUMN IF EXISTS title_basis,
--   DROP COLUMN IF EXISTS title_convention, DROP COLUMN IF EXISTS
--   title_canonical_key (l'ancien code les ignore).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE asset_files
  ADD COLUMN IF NOT EXISTS title_basis         JSONB,
  ADD COLUMN IF NOT EXISTS title_convention    TEXT,
  ADD COLUMN IF NOT EXISTS title_canonical_key TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_files_title_convention_check') THEN
    ALTER TABLE asset_files ADD CONSTRAINT asset_files_title_convention_check
      CHECK (title_convention IS NULL OR title_convention IN ('PERIODIC')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_files_title_basis_check') THEN
    ALTER TABLE asset_files ADD CONSTRAINT asset_files_title_basis_check
      CHECK (title_basis IS NULL OR jsonb_typeof(title_basis) = 'object') NOT VALID;
  END IF;
END
$$;
ALTER TABLE asset_files VALIDATE CONSTRAINT asset_files_title_convention_check;
ALTER TABLE asset_files VALIDATE CONSTRAINT asset_files_title_basis_check;

COMMENT ON COLUMN asset_files.title_basis IS
  'Lot 87D : données de nommage et provenance (période facturée, mois principal IA, émission, références de facture) — écrites par le service de nommage seulement.';
COMMENT ON COLUMN asset_files.title_convention IS
  'Lot 87D : convention du titre automatique (PERIODIC) ; NULL : composition générale (harmonisation T3 possible).';
COMMENT ON COLUMN asset_files.title_canonical_key IS
  'Lot 87D : clé du groupe canonique (nature | fournisseur | période) — désambiguïsation déterministe.';
