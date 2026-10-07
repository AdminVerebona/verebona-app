-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0274 : version du moteur T3 DOCUMENT_ASSET et invalidation par les
-- identifiants canoniques des biens (lot 32C — ticket « Rattrapage des
-- documents déjà ABSTAINED / NO_CANDIDATE »).
--
-- 1. document_asset_resolutions — trois colonnes :
--   · resolution_version      version MÉTIER du moteur ayant produit la
--                             dernière issue (`DOCUMENT_ASSET_RESOLUTION_VERSION`,
--                             `document-asset/version.ts`). NULL = ligne
--                             historique (lot 31B) : ancienne version, donc
--                             rattrapable par le balayage horaire tant que le
--                             document est sans bien et sans décision
--                             utilisateur ;
--   · evaluated_at            dernière évaluation complète (issue, ou
--                             confirmation sur des entrées identiques) ;
--   · identifiers_fingerprint empreinte (sha256) des identifiants canoniques
--                             des biens du compte lors de cette évaluation —
--                             aucune valeur en clair (adresse : sensible).
--
-- 2. document_asset_identifier_changes — journal MINIMAL des modifications qui
--    peuvent changer l'identification d'un bien (création, suppression,
--    adresse, code postal, ville, immatriculation, caractéristiques, famille).
--    Tenu par déclencheur sur `assets` (tous chemins d'écriture : fiche,
--    import, T3, migration…). Une abstention évaluée AVANT la dernière
--    modification du compte est reconsidérée : le balayage compare alors
--    l'empreinte des identifiants et ne remet en file que si elle a changé.
--    Insertions seules (aucune ligne partagée mise à jour : ni attente ni
--    interblocage entre écritures concurrentes de biens) ; compactée à chaque
--    cycle du balayage (seule la plus récente par compte sert).
--
-- Rattrapage des données existantes : aucun SQL ici — les lignes ABSTAINED /
-- NO_CANDIDATE sans version sont reprises PROGRESSIVEMENT par le balayage
-- horaire T3 (pages bornées, file durable, sans relancer T1).
--
-- VERROUS : ADD COLUMN sans défaut (métadonnées seules) ; table neuve ;
-- déclencheur : verrou SHARE ROW EXCLUSIVE bref sur assets, borné par
-- lock_timeout. Idempotente : IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER
-- IF EXISTS.
-- Retour arrière : DROP TRIGGER assets_document_asset_identifier_changes_* ON
-- assets ; DROP FUNCTION document_asset_identifier_changed() ; DROP TABLE
-- document_asset_identifier_changes ; les colonnes peuvent rester (l'ancien
-- code les ignore).
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE document_asset_resolutions ADD COLUMN IF NOT EXISTS resolution_version INTEGER;
ALTER TABLE document_asset_resolutions ADD COLUMN IF NOT EXISTS evaluated_at TIMESTAMPTZ;
ALTER TABLE document_asset_resolutions ADD COLUMN IF NOT EXISTS identifiers_fingerprint TEXT;

COMMENT ON COLUMN document_asset_resolutions.resolution_version IS
  'Version métier du moteur T3 DOCUMENT_ASSET ayant produit la dernière issue (NULL : ancienne version, rattrapable).';

-- Pas de clé étrangère : une suppression de compte (cascade sur assets)
-- déclenche aussi la journalisation, qui ne doit jamais la faire échouer.
CREATE TABLE IF NOT EXISTS document_asset_identifier_changes (
  id          BIGSERIAL   PRIMARY KEY,
  account_id  INTEGER     NOT NULL,
  asset_id    INTEGER,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Table neuve (vide) : index créé ici, sans CONCURRENTLY.
CREATE INDEX IF NOT EXISTS document_asset_identifier_changes_account_idx
  ON document_asset_identifier_changes (account_id, changed_at);

CREATE OR REPLACE FUNCTION document_asset_identifier_changed() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  -- Une ligne par bien modifié ; aucune lecture, aucun bloc EXCEPTION.
  IF TG_OP = 'DELETE' THEN
    IF OLD.account_id IS NOT NULL THEN
      INSERT INTO document_asset_identifier_changes (account_id, asset_id) VALUES (OLD.account_id, OLD.id);
    END IF;
  ELSIF NEW.account_id IS NOT NULL THEN
    INSERT INTO document_asset_identifier_changes (account_id, asset_id) VALUES (NEW.account_id, NEW.id);
    IF TG_OP = 'UPDATE' AND OLD.account_id IS DISTINCT FROM NEW.account_id AND OLD.account_id IS NOT NULL THEN
      INSERT INTO document_asset_identifier_changes (account_id, asset_id) VALUES (OLD.account_id, OLD.id);
    END IF;
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS assets_document_asset_identifier_changes_ins_del ON assets;
CREATE TRIGGER assets_document_asset_identifier_changes_ins_del
  AFTER INSERT OR DELETE ON assets
  FOR EACH ROW EXECUTE FUNCTION document_asset_identifier_changed();

-- Ne se déclenche que si une source d'identifiant CHANGE (les mises à jour
-- de statut, de vignette, de valorisation… ne le sollicitent pas).
DROP TRIGGER IF EXISTS assets_document_asset_identifier_changes_upd ON assets;
CREATE TRIGGER assets_document_asset_identifier_changes_upd
  AFTER UPDATE OF address, postal_code, city, registration_number, key_characteristics, category, deleted_at, account_id ON assets
  FOR EACH ROW
  WHEN (OLD.address IS DISTINCT FROM NEW.address
     OR OLD.postal_code IS DISTINCT FROM NEW.postal_code
     OR OLD.city IS DISTINCT FROM NEW.city
     OR OLD.registration_number IS DISTINCT FROM NEW.registration_number
     OR OLD.key_characteristics IS DISTINCT FROM NEW.key_characteristics
     OR OLD.category IS DISTINCT FROM NEW.category
     OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
     OR OLD.account_id IS DISTINCT FROM NEW.account_id)
  EXECUTE FUNCTION document_asset_identifier_changed();
