-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0221 : relation N-N canonique document ↔ bien (CDC 15 X-01, §12
-- « document_asset_links : relation N-N canonique document<->bien », T1-05 ;
-- plan D-11 : « trigger SQL depuis asset_files, puis écriture directe »).
--
-- Un document (`asset_files`) peut concerner plusieurs biens, pièces ou
-- équipements. Chaque lien porte :
--   · link_role   PRIMARY (bien principal) | SECONDARY (lié) | MENTIONED
--                 (seulement cité par le document) ;
--   · origin      USER (choix explicite) | AI (T1, chemin master) |
--                 MIGRATION (rattrapage §14.8) | LEGACY_COLUMN (reflet des
--                 colonnes historiques, tenu par le déclencheur) ;
--   · confidence  0 → 1 ;
--   · status      ACTIVE | PROPOSED | REJECTED | REMOVED — jamais de DELETE
--                 applicatif : un retrait garde sa trace (`removed_at`).
--
-- COMPATIBILITÉ TRANSITOIRE : les colonnes `asset_files.asset_id`,
-- `linked_asset_id`, `linked_room_id` et `equipment_id` restent la source des
-- écrans et exports actuels. Le déclencheur (0221_*_trigger.sql) tient à jour
-- les liens LEGACY_COLUMN à partir d'elles, ligne par ligne ; il ne touche
-- jamais un lien USER, AI ou MIGRATION. Aucun écran ni export ne lit encore
-- cette table (lots 15 et 16).
--
-- Index dans 0221_*_idx_*.sql (CONCURRENTLY, un par fichier), déclencheur
-- dans 0221_*_trigger.sql (après les index : l'unicité partielle existe
-- quand il commence à écrire). Rattrapage : `scripts/backfill-document-asset-links.ts`.
--
-- VERROUS : création d'une table neuve, aucun verrou sur asset_files.
-- Idempotente : IF NOT EXISTS ; contraintes nommées, ajoutées si absentes.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_asset_links (
  id            BIGSERIAL PRIMARY KEY,
  account_id    INTEGER     NOT NULL REFERENCES accounts(id)    ON DELETE CASCADE,
  file_id       INTEGER     NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  asset_id      INTEGER              REFERENCES assets(id)      ON DELETE CASCADE,
  room_id       INTEGER              REFERENCES rooms(id)       ON DELETE CASCADE,
  equipment_id  INTEGER              REFERENCES equipments(id)  ON DELETE CASCADE,
  link_role     TEXT        NOT NULL,
  origin        TEXT        NOT NULL,
  confidence    NUMERIC(4, 3),
  status        TEXT        NOT NULL DEFAULT 'ACTIVE',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at    TIMESTAMPTZ,
  CONSTRAINT document_asset_links_role_check       CHECK (link_role IN ('PRIMARY', 'SECONDARY', 'MENTIONED')),
  CONSTRAINT document_asset_links_origin_check     CHECK (origin IN ('USER', 'AI', 'MIGRATION', 'LEGACY_COLUMN')),
  CONSTRAINT document_asset_links_status_check     CHECK (status IN ('ACTIVE', 'PROPOSED', 'REJECTED', 'REMOVED')),
  CONSTRAINT document_asset_links_confidence_check CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT document_asset_links_target_check     CHECK (asset_id IS NOT NULL OR room_id IS NOT NULL OR equipment_id IS NOT NULL)
);

COMMENT ON TABLE document_asset_links IS
  'Relation N-N canonique document <-> bien / pièce / équipement (CDC 15 X-01). Liens LEGACY_COLUMN tenus par déclencheur depuis asset_files.';
