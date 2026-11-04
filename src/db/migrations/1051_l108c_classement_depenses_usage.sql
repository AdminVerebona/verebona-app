-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1051 : dépenses d'usage — CLASSEMENT d'une dépense réelle par
-- l'utilisateur (lot 108C, ticket TCO-646 §E).
--
--   asset_usage_line_assignments — au plus un classement par bien et par clé
--   STABLE de ligne TCO (`line_key`, même clé que les décisions 0623,
--   src/services/business-operations/tco/user-decisions.ts `tcoLineKeys`).
--   `usage_category` : FUEL | CHARGING | TOLLS | OTHER | NONE (« pas une
--   dépense d'usage »). Pour OTHER, `other_label` désigne le forfait
--   « Autre » visé. La catégorie d'usage n'est JAMAIS devinée au hasard :
--   ce classement prime sur le vocabulaire explicite du libellé.
--   Annuler = supprimer la ligne (retour au classement automatique).
--   `line_id`, montant, libellé, fichier : contexte au moment du geste
--   (diagnostic BO), jamais relus comme montant. Aucun ticket modifié,
--   aucune Opération créée.
--
-- Le bien porte le compte (`ASSET_SCOPED_TABLES`), garde d'isolation 0373,
-- CASCADE avec le bien ou le compte. Table neuve, index dans 1051_..._idx_1
-- (CONCURRENTLY). Idempotente. Retour arrière : DROP TABLE IF EXISTS
-- asset_usage_line_assignments (le moteur l'ignore si absente).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS asset_usage_line_assignments (
  id              BIGSERIAL    PRIMARY KEY,
  account_id      INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id        INTEGER      NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  line_key        TEXT         NOT NULL,
  usage_category  TEXT         NOT NULL,
  other_label     TEXT,
  line_id         TEXT,
  amount_minor    BIGINT,
  currency        TEXT,
  label           TEXT,
  file_id         INTEGER      REFERENCES asset_files(id) ON DELETE SET NULL,
  decided_by      INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  decided_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT asset_usage_line_assignments_category_chk CHECK (usage_category IN ('FUEL', 'CHARGING', 'TOLLS', 'OTHER', 'NONE')),
  CONSTRAINT asset_usage_line_assignments_key_chk CHECK (length(line_key) BETWEEN 1 AND 200),
  CONSTRAINT asset_usage_line_assignments_other_chk CHECK (other_label IS NULL OR length(other_label) <= 120),
  CONSTRAINT asset_usage_line_assignments_label_chk CHECK (label IS NULL OR length(label) <= 300),
  CONSTRAINT asset_usage_line_assignments_unique UNIQUE (account_id, asset_id, line_key)
);

COMMENT ON TABLE asset_usage_line_assignments IS
  'Lot 108C : classement par l''utilisateur d''une dépense réelle en dépense d''usage (carburant, recharge, péage, autre, ou aucune) — rapprochement catégoriel forfait / réel ; prioritaire sur le vocabulaire du libellé ; réversible.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'account_isolation_link_guard') THEN
    DROP TRIGGER IF EXISTS asset_usage_line_assignments_isolation_guard ON asset_usage_line_assignments;
    CREATE TRIGGER asset_usage_line_assignments_isolation_guard
      BEFORE INSERT OR UPDATE OF asset_id ON asset_usage_line_assignments
      FOR EACH ROW EXECUTE FUNCTION account_isolation_link_guard('account', 'account_id', 'asset', 'asset_id');
  END IF;
END $$;
