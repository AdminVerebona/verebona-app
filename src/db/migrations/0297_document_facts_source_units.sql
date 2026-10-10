-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0297 : provenance des faits T1 — fait → sourceUnitId[] (lot 34F).
--
-- `document_facts.source_unit_ids` : unités de `document_source_units` qui
-- prouvent le fait (`page:2:block:14`, `page:5:table:2:row:4:cell:3`…). On
-- retrouve ainsi document → page → unité → contenu source → fait produit.
--
-- Colonne NULLABLE sans valeur par défaut : ajout instantané (catalogue seul,
-- aucune réécriture de la table, volumineuse). NULL = fait antérieur ; la
-- tâche `t1-source-units-backfill` la renseigne progressivement à partir des
-- extraits déjà persistés (sans appel IA). Index dans `0297_idx_1`
-- (CONCURRENTLY, optionnel). Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE document_facts ADD COLUMN IF NOT EXISTS source_unit_ids TEXT[];
