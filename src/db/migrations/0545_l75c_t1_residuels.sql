-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0545 : T1 — écarts résiduels d'extraction exhaustive et de
-- persistance métier (lot 75C, ticket « [P1] T1 — Corriger les écarts
-- résiduels… », points B et F).
--
-- POURQUOI DES COLONNES (et aucune table neuve)
--   Le modèle existant ne permettait pas :
--
--   B. de conserver DURABLEMENT, par page, le texte que la lecture du modèle
--      (OCR multimodal, déjà produite par T1) a reconnu sur les pages SANS
--      couche texte — sans écraser l'extract déterministe d'origine. Colonnes
--      `ocr_*` de `document_raw_extracts` (une ligne par fichier) :
--        · `ocr_pages`  : [{ page, status RECOGNIZED | UNREADABLE |
--                          UNATTRIBUTED, provenance MODEL_TRANSCRIPTION,
--                          text, chars, sourceUnitIds, zones, reason }] ;
--        · `ocr_status` : NOT_REQUIRED (toutes les pages ont une couche
--                          texte), COMPLETE, PARTIAL (pages illisibles),
--                          NONE (aucune page reconnue), UNATTRIBUTED
--                          (transcription non attribuable à une page) ;
--        · pages reconnues / illisibles, caractères, run d'origine.
--      `full_text` (couche texte) n'est JAMAIS modifié par ces colonnes.
--
--   F. de distinguer « analyse IA dédupliquée » et « écritures métier
--      achevées ». `document_analysis_runs` :
--        · `writes_status` : PENDING (écritures en cours), SUCCEEDED,
--          PARTIAL (écritures secondaires), FAILED (écriture obligatoire
--          manquante) — NULL pour les runs antérieurs ;
--        · `master_snapshot` : sortie STRUCTURÉE du master conservée tant que
--          les écritures ne sont pas achevées — la reprise la REJOUE sans
--          rappeler Gemini ; effacée dès que la persistance aboutit (aucune
--          duplication durable du contenu).
--
-- ALTER sur tables existantes : colonnes NULLABLES ou à défaut CONSTANT
-- (instantané depuis PG 11, aucune réécriture) ; contraintes `NOT VALID`
-- (aucun balayage, imposées aux nouvelles écritures). Aucune donnée existante
-- modifiée. Idempotente (IF NOT EXISTS, DROP CONSTRAINT IF EXISTS).
-- Retour arrière : colonnes ignorées par l'ancien code (ALTER TABLE … DROP
-- COLUMN IF EXISTS … si nécessaire) ; le code tolère leur absence (reprise
-- sans sortie rejouée, OCR non persisté → phase d'extraction PARTIELLE).
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

-- ── B : transcription des pages sans couche texte ────────────────────────────
ALTER TABLE document_raw_extracts ADD COLUMN IF NOT EXISTS ocr_status TEXT;
ALTER TABLE document_raw_extracts ADD COLUMN IF NOT EXISTS ocr_pages JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE document_raw_extracts ADD COLUMN IF NOT EXISTS ocr_pages_recognized INTEGER[] NOT NULL DEFAULT '{}';
ALTER TABLE document_raw_extracts ADD COLUMN IF NOT EXISTS ocr_pages_unreadable INTEGER[] NOT NULL DEFAULT '{}';
ALTER TABLE document_raw_extracts ADD COLUMN IF NOT EXISTS ocr_chars INTEGER NOT NULL DEFAULT 0;
ALTER TABLE document_raw_extracts ADD COLUMN IF NOT EXISTS ocr_analysis_run_id INTEGER;
ALTER TABLE document_raw_extracts ADD COLUMN IF NOT EXISTS ocr_at TIMESTAMPTZ;
ALTER TABLE document_raw_extracts DROP CONSTRAINT IF EXISTS document_raw_extracts_ocr_chk;
ALTER TABLE document_raw_extracts ADD CONSTRAINT document_raw_extracts_ocr_chk
  CHECK (ocr_status IS NULL OR ocr_status IN ('NOT_REQUIRED', 'COMPLETE', 'PARTIAL', 'NONE', 'UNATTRIBUTED')) NOT VALID;

-- ── F : achèvement des écritures d'un run, sortie structurée rejouable ───────
ALTER TABLE document_analysis_runs ADD COLUMN IF NOT EXISTS writes_status TEXT;
ALTER TABLE document_analysis_runs ADD COLUMN IF NOT EXISTS writes_error TEXT;
ALTER TABLE document_analysis_runs ADD COLUMN IF NOT EXISTS writes_at TIMESTAMPTZ;
ALTER TABLE document_analysis_runs ADD COLUMN IF NOT EXISTS master_snapshot JSONB;
ALTER TABLE document_analysis_runs DROP CONSTRAINT IF EXISTS document_analysis_runs_writes_chk;
ALTER TABLE document_analysis_runs ADD CONSTRAINT document_analysis_runs_writes_chk
  CHECK (writes_status IS NULL OR writes_status IN ('PENDING', 'SUCCEEDED', 'PARTIAL', 'FAILED')) NOT VALID;

COMMENT ON COLUMN document_raw_extracts.ocr_pages IS
  'Lot 75C : texte reconnu par la lecture du modèle sur les pages sans couche texte, par page (provenance MODEL_TRANSCRIPTION, unités source, zones) ; full_text reste la couche texte d''origine.';
COMMENT ON COLUMN document_analysis_runs.master_snapshot IS
  'Lot 75C : sortie structurée du master T1, conservée tant que writes_status <> SUCCEEDED/PARTIAL — rejouée par la reprise sans nouvel appel Gemini, puis effacée.';
