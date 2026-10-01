-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0225 (suite) : copie RESTAURABLE de TOUTES les écritures des
-- rattrapages CDC 15 (relecture du lot 17, volet B).
--
-- Chaque valeur modifiée par une étape est copiée ICI, EN CLAIR (y compris
-- une adresse ou un autre champ sensible), dans la MÊME transaction que
-- l'écriture — `scripts/cdc15-backfill.ts --restore <runId>` remet tout en
-- place, dans l'ordre inverse, et refuse (conflit) toute valeur modifiée
-- depuis l'exécution :
--
--   target_type    target_id     name                    étapes
--   asset_column   bien          colonne de `assets`     MIG-02, MIG-07
--   asset_kc       bien          clé de keyCharacteristics (valeur,
--                                `__origin`, `_origin`, `__updatedAt`,
--                                `__originBasis`… : une ligne par clé)
--                                                        MIG-01, MIG-02, MIG-03, MIG-07
--   field_evidence preuve        colonne de la preuve    MIG-01, MIG-04
--   document_fact  fait          colonne du fait         MIG-01
--
--   old_value / new_value : `{"v": valeur}` (forme texte pour une colonne SQL),
--   NULL pour une clé de fiche ABSENTE.
--
-- MIG-05, 06 et 08 (services existants) ne sont pas couverts : leurs retraits
-- sont tracés par `agenda_item_removals`, leurs liens sont des ajouts.
--
-- ACCÈS RESTREINT : table distincte du rapport — jamais lue par `--report`,
-- ni exposée par l'application ; seule la restauration la lit. Aucun droit
-- pour PUBLIC. Compte supprimé → copies supprimées (cascade). Table
-- nouvelle (0225 non livrée) : aucun verrou sur l'existant.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cdc15_migration_backups (
  id           BIGSERIAL PRIMARY KEY,
  run_id       UUID NOT NULL,
  step         TEXT NOT NULL,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id     INTEGER,
  target_type  TEXT NOT NULL,
  target_id    BIGINT NOT NULL,
  name         TEXT NOT NULL,
  old_value    JSONB,
  new_value    JSONB,
  restored_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cdc15_migration_backups_target_check
    CHECK (target_type IN ('asset_column', 'asset_kc', 'field_evidence', 'document_fact'))
);

CREATE INDEX IF NOT EXISTS cdc15_migration_backups_run_idx ON cdc15_migration_backups (run_id, id);

REVOKE ALL ON cdc15_migration_backups FROM PUBLIC;

COMMENT ON TABLE cdc15_migration_backups IS
  'Copie restaurable (en clair, accès restreint) de toutes les écritures des rattrapages CDC 15 — lue seulement par cdc15-backfill --restore.';
