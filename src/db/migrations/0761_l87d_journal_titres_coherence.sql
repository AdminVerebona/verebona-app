-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0761 : journal des titres — origine COHERENCE (lot 87D).
--
-- `document_title_events.origin` admet désormais 'COHERENCE' : réparation du
-- stock par le contrôle de cohérence COH-DOC-TITLES, au travers du service de
-- nommage (`ensureBusinessTitle`, origine COHERENCE). Les origines T1 / T3
-- restent admises (historique et traitements courants).
-- Contrainte remplacée NOT VALID puis VALIDATE (n'empêche pas les écritures).
-- Idempotente. Retour arrière : remettre CHECK (origin IN ('T1', 'T3')) après
-- suppression des lignes COHERENCE (l'ancien code n'en écrit pas).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE document_title_events DROP CONSTRAINT IF EXISTS document_title_events_origin_check;
ALTER TABLE document_title_events ADD CONSTRAINT document_title_events_origin_check
  CHECK (origin IN ('T1', 'T3', 'COHERENCE')) NOT VALID;
ALTER TABLE document_title_events VALIDATE CONSTRAINT document_title_events_origin_check;
