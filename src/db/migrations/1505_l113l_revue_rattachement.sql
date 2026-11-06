-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1505 : revue IA du rattachement d'un document (lot 113L, ticket
-- #711 « Rattachement documentaire — Confier à l'IA l'arbitrage des indices et
-- supprimer les faux conflits automatiques »).
--
-- document_asset_resolutions.attachment_review — trace et mémoire de la
-- DERNIÈRE revue T3 du rattachement d'un document déjà rattaché (une ligne par
-- document, table existante de T3 DOCUMENT_ASSET) : indices soumis (bien,
-- nature, unités sources), unités transmises, candidats, contrat du prompt,
-- version de prompt et traces de l'appel, décision (confirmée, arbitrage,
-- multi-biens, aucune décision), justification concise, effet sur la carte
-- « À traiter » LINK-ASSET-CONFLICT, échec et relance. JAMAIS une valeur
-- d'identifiant (adresse : donnée sensible).
--
-- Additive (colonne nullable sans défaut : métadonnées seules), idempotente,
-- rejouable. L'ancien code l'ignore. Aucune donnée réécrite ici : la reprise
-- des cartes ouvertes passe par la phase « À traiter ouverts » de T3, carte
-- par carte, après analyse (jamais de fermeture en masse).
-- Retour arrière : ALTER TABLE document_asset_resolutions DROP COLUMN attachment_review.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE document_asset_resolutions ADD COLUMN IF NOT EXISTS attachment_review JSONB;
