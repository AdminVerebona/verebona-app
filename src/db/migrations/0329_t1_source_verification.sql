-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0329 : T1 — couverture RÉELLE de la source et état de réparation
-- (lot 49B — ticket « T1 — Garantir la couverture réelle des documents et
-- corriger les pertes résiduelles d'extraction », DEV-01 à DEV-04, §6, §7).
--
--   document_source_units.repair_state
--       PENDING (jamais examinée faute de budget, reprise programmée),
--       ATTEMPTED_FAILED, SUCCEEDED, EXHAUSTED (plafond atteint),
--       NEEDS_SOURCE (relecture du fichier nécessaire) ; NULL : aucune.
--   document_extraction_coverage.source_verification
--       VERIFIED, PARTIAL, UNVERIFIABLE, NOT_APPLICABLE, RECONSTRUCTED —
--       attribut DISTINCT de l'état de qualité (information comprise ≠
--       document effectivement lu) ; NULL : analyse antérieure au lot 49B.
--   document_extraction_coverage.verification (JSONB, compteurs et numéros
--       de page seulement, jamais de contenu) : pages attendues / vérifiées /
--       manquantes / non vérifiées / scannées / relues, unités incertaines,
--       réparations en attente / épuisées, troncatures et originaux conservés.
--   document_extraction_coverage.last_retry_at / last_retry_result :
--       dernière reprise automatique et son résultat (BO).
--
-- Colonnes NULLABLES sans défaut : ajout instantané (catalogue seulement),
-- aucune réécriture, aucune migration de données. Idempotente.
-- Retour arrière : ALTER TABLE … DROP COLUMN IF EXISTS … (code tolérant :
-- colonnes absentes → écriture sans diagnostics).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE document_source_units ADD COLUMN IF NOT EXISTS repair_state TEXT;
ALTER TABLE document_extraction_coverage ADD COLUMN IF NOT EXISTS source_verification TEXT;
ALTER TABLE document_extraction_coverage ADD COLUMN IF NOT EXISTS verification JSONB;
ALTER TABLE document_extraction_coverage ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ;
ALTER TABLE document_extraction_coverage ADD COLUMN IF NOT EXISTS last_retry_result TEXT;
