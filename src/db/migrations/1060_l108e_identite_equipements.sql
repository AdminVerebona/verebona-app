-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1060 : groupes d'identité documentaire d'APPAREILS (lot 108E,
-- ticket « T3 DOCUMENT_ASSET — correctif #626 bis », A2).
--
-- Le journal des groupes `document_identity_groups` (0995, lot 105D)
-- n'admettait que les familles PROPERTY et VEHICLE. Les groupes d'équipement
-- / objet (même numéro de série ou IMEI lu par plusieurs documents : facture
-- et garantie d'un même appareil) sont désormais calculés par T3 : la
-- contrainte de famille ADMET EQUIPMENT. Élargissement seul : aucune ligne
-- modifiée, aucune donnée supprimée, aucune colonne nouvelle.
--
-- Additive, idempotente, rejouable. Sans elle, T3 fonctionne (groupes
-- d'appareils calculés et utilisés) mais ne les journalise pas : la phase est
-- PARTIELLE et une anomalie Supervision « migration 1060 absente » est ouverte
-- (jamais un passage « terminé »).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE document_identity_groups DROP CONSTRAINT IF EXISTS document_identity_groups_family_chk;
ALTER TABLE document_identity_groups ADD CONSTRAINT document_identity_groups_family_chk
  CHECK (identity_family IN ('PROPERTY', 'VEHICLE', 'EQUIPMENT'));
