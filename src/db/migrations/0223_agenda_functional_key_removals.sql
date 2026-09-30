-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0223 (suite) : trace des retraits d'éléments d'agenda
-- (CDC 15 T4-08, §14 point 6 ; relecture du lot 14).
--
-- `agenda_items` n'a ni statut de suppression ni `deleted_at`, et ses lectures
-- (Drizzle, `select()` complet) sont trop nombreuses pour qu'on y ajoute une
-- suppression logique sans risque. Tout retrait AUTOMATIQUE (synchronisation
-- d'une source réanalysée, dédoublonnage §14.6) écrit donc, DANS LA MÊME
-- INSTRUCTION que le DELETE, une ligne ici : clé fonctionnelle, date, titre,
-- source, bien, motif et l'image complète de l'élément et de ses liens — de
-- quoi le rattraper. `agenda_occurrence_events` ne convient pas : ses lignes
-- sont supprimées en cascade avec l'élément.
--
-- Sans clé étrangère vers `agenda_items` (l'élément n'existe plus) ; compte
-- supprimé → traces supprimées. Table nouvelle : aucun verrou sur l'existant.
-- Idempotente (IF NOT EXISTS). Non déclarée dans Drizzle : écrite et lue en SQL
-- (`services/agenda/agenda-removal-trace.ts`).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agenda_item_removals (
  id              BIGSERIAL PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agenda_item_id  INTEGER NOT NULL,
  functional_key  TEXT,
  start_date      DATE,
  title           TEXT,
  source_file_id  INTEGER,
  asset_id        INTEGER,
  reason          TEXT NOT NULL,
  item_snapshot   JSONB NOT NULL,
  links_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
  removed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agenda_item_removals_account_idx ON agenda_item_removals (account_id, removed_at);
CREATE INDEX IF NOT EXISTS agenda_item_removals_source_idx ON agenda_item_removals (source_file_id);

COMMENT ON TABLE agenda_item_removals IS
  'Retraits automatiques d''éléments d''agenda (CDC 15 T4-08, §14.6) : image de l''élément et de ses liens, pour rattrapage.';
