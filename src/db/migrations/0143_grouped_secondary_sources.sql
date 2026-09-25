-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0143 — Sources secondaires regroupées : masquées, jamais purgées
--
-- Quand plusieurs fichiers forment un même document, T1 les regroupe autour
-- d'une source principale et masque les secondaires… en posant `deleted_at`.
-- Or le cleanup générique supprime physiquement (S3 + base) tout fichier
-- dont `deleted_at` dépasse 30 jours : les pages originales, preuves du
-- document, disparaissaient.
--
-- Masquage et suppression deviennent deux notions distinctes :
--   · `grouped_into_file_id` / `grouped_at` : la source est rattachée à un
--     document logique. Elle n'apparaît plus comme document autonome, mais
--     reste en stockage et consultable depuis les preuves du document.
--   · `deleted_at` seul (sans regroupement) : suppression réelle, purgée
--     après la rétention.
--
-- `deleted_at` reste posé sur les secondaires pour que les ~80 lectures qui
-- listent les documents autonomes continuent de les masquer ; le cleanup et
-- l'accès aux fichiers lisent désormais le regroupement.
-- Une secondaire ne devient purgeable que si son document principal est
-- lui-même supprimé depuis plus de 30 jours (ou n'existe plus).
--
-- ── RATTRAPAGE ─────────────────────────────────────────────────────────────
-- Les regroupements passés sont retrouvés par les éléments de lot qui
-- partagent la même analyse (`current_analysis_run_id`) : la source de
-- l'analyse est la principale, les autres fichiers masqués sont ses
-- secondaires.
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS grouped_into_file_id INTEGER
  REFERENCES asset_files(id) ON DELETE SET NULL;
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS grouped_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS asset_files_grouped_into_idx
  ON asset_files (grouped_into_file_id)
  WHERE grouped_into_file_id IS NOT NULL;

UPDATE asset_files f
   SET grouped_into_file_id = r.asset_file_id,
       grouped_at = COALESCE(f.grouped_at, f.deleted_at, now())
  FROM document_lot_items li
  JOIN document_analysis_runs r ON r.id = li.current_analysis_run_id
 WHERE li.asset_file_id = f.id
   AND f.id <> r.asset_file_id
   AND f.deleted_at IS NOT NULL
   AND f.grouped_into_file_id IS NULL
   AND f.account_id = (SELECT account_id FROM asset_files lead WHERE lead.id = r.asset_file_id);
