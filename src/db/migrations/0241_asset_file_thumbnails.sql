-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0241 : miniatures des documents (APP-PERF-06 images, APP-PERF-27 PDF)
--
-- Une ligne par (document, variante) : statut, VERSION SOURCE (clé S3 de
-- l'original au moment de la génération), format, dimensions, clé du dérivé.
--   · version source ≠ `asset_files.s3_key` courant → dérivé périmé, jamais
--     servi (remplacement du fichier) ; régénéré à la demande suivante ;
--   · statuts : PENDING (à faire), PROCESSING (bail `lease_until` : une
--     génération interrompue est reprise après expiration), READY, FAILED
--     (`attempts` plafonné : pas de boucle), UNSUPPORTED (format illisible,
--     PDF protégé…) ;
--   · le dérivé vit dans le bucket canonique, préfixe `derivatives/` ; il
--     n'est pas décompté du quota utilisateur (dérivé système de petite
--     taille, régénérable).
--
-- Cycle de vie des objets (CA-03) : toute disparition d'une ligne (purge du
-- document, suppression d'un bien ou d'un compte par cascade) ou tout
-- changement de clé du dérivé met l'ANCIEN objet en file de purge
-- (`pending_blob_deletions`, traitée par la maintenance quotidienne). Un seul
-- mécanisme, quel que soit le chemin de suppression. Les miniatures de BIENS
-- (`assets.thumbnail_url`) ont leur propre cycle de vie et ne sont pas
-- concernées.
--
-- Idempotente : IF NOT EXISTS ; CREATE OR REPLACE FUNCTION ; DROP TRIGGER IF
-- EXISTS puis CREATE TRIGGER.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS asset_file_thumbnails (
  id            SERIAL PRIMARY KEY,
  file_id       INTEGER     NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  account_id    INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  variant       TEXT        NOT NULL DEFAULT 'list',
  status        TEXT        NOT NULL DEFAULT 'PENDING',
  source_key    TEXT        NOT NULL,
  source_size   INTEGER,
  s3_key        TEXT,
  format        TEXT,
  width         INTEGER,
  height        INTEGER,
  bytes         INTEGER,
  attempts      INTEGER     NOT NULL DEFAULT 0,
  error_code    TEXT,
  lease_until   TIMESTAMPTZ,
  generated_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT asset_file_thumbnails_status_check
    CHECK (status IN ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'UNSUPPORTED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS asset_file_thumbnails_file_variant_uidx
  ON asset_file_thumbnails (file_id, variant);
CREATE INDEX IF NOT EXISTS asset_file_thumbnails_account_idx
  ON asset_file_thumbnails (account_id);

CREATE OR REPLACE FUNCTION asset_file_thumbnails_purge_blob() RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.s3_key IS NOT NULL
     AND (TG_OP = 'DELETE' OR OLD.s3_key IS DISTINCT FROM NEW.s3_key) THEN
    INSERT INTO pending_blob_deletions (file_id, storage_path, scheduled_for, created_at)
    VALUES (NULL, OLD.s3_key, now(), now());
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS asset_file_thumbnails_purge_blob_trg ON asset_file_thumbnails;
CREATE TRIGGER asset_file_thumbnails_purge_blob_trg
  AFTER DELETE OR UPDATE OF s3_key ON asset_file_thumbnails
  FOR EACH ROW EXECUTE FUNCTION asset_file_thumbnails_purge_blob();
