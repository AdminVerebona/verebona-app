-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0655 : Opération ↔ Pièces et appartenance des documents
-- (lot 82, chantier 82D — CDC v5 O-1 : §6.2, §6.3, §27.3, §27.4 ; E17 ;
-- arbitrages PO V-Q6 et V-Q8).
--
--   business_operation_room_links    Pièces concernées par une Opération
--     (0..N), sur le modèle de `business_operation_equipment_links` : bien
--     porteur (intégrité, transfert), autorité, source de preuve, état actif.
--     La Pièce est la table `substructures` — la SEULE représentation des
--     Pièces depuis la fusion D-G du lot 20 (migration 0229 : `rooms` est
--     dépréciée). Aucun second modèle (V-Q6) : `substructure_id` est le nom
--     technique historique de l'identifiant de Pièce, conservé tel quel.
--
--   business_operation_documents     APPARTENANCE d'un document au
--     regroupement, distincte de la PROVENANCE d'une information
--     (`business_operation_sources`, §27.3). `origins` :
--       SOURCE  le document est une source DOCUMENT active de l'Opération
--               (tenue par le déclencheur ci-dessous, quel que soit le
--               chemin : T3, fusion, retrait de source) ;
--       USER    rattachement explicite de l'utilisateur (geste) ;
--     `active` est CALCULÉ (au moins une origine) : aucune incohérence
--     possible entre les deux colonnes. Un même document peut appartenir à
--     plusieurs Opérations sans duplication du fichier (§6.2, AC09).
--
-- GARDE INTERCOMPTES (filet de la base, comme 0332) : la Pièce (via son bien)
-- et le document doivent appartenir au compte de la ligne à l'insertion ou au
-- changement de cible ; l'Opération est du même compte par la clé composée.
-- Comme 0332, le changement de COMPTE (déplacement d'un bien : Opérations,
-- bien et documents changent de compte en plusieurs étapes d'une même
-- transaction) n'est pas contrôlé ici : les liens qui franchiraient les
-- comptes sont retirés par le transfert (`detachCrossAccountGroupingInTx`).
--
-- REPRISE : appartenance SOURCE reconstruite depuis les sources DOCUMENT
-- actives (documents du même compte). Aucune Pièce n'est rattachée ici : les
-- Pièces d'une Opération viennent de la consolidation T3 (cibles ROOM
-- certaines de T1) ou d'un geste utilisateur.
--
-- Tables neuves : aucun verrou long. Index secondaires : 0655_…_idx_1/2.
-- Idempotente. Retour arrière : DROP TRIGGER business_operation_sources_documents_sync
-- ON business_operation_sources ; DROP TABLE business_operation_documents,
-- business_operation_room_links ; DROP FUNCTION des trois fonctions.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS business_operation_room_links (
  id                          BIGSERIAL    PRIMARY KEY,
  account_id                  INTEGER      NOT NULL,
  operation_id                BIGINT       NOT NULL,
  substructure_id             INTEGER      NOT NULL REFERENCES substructures(id) ON DELETE CASCADE,
  asset_id                    INTEGER      NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  authority                   TEXT         NOT NULL,
  source_operation_source_id  BIGINT       REFERENCES business_operation_sources(id) ON DELETE SET NULL,
  active                      BOOLEAN      NOT NULL DEFAULT true,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT business_operation_room_links_operation_fk FOREIGN KEY (operation_id, account_id)
    REFERENCES business_operations (id, account_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT business_operation_room_links_authority_chk CHECK (authority IN ('USER', 'DOCUMENT', 'STRUCTURED', 'INFERENCE'))
);
CREATE UNIQUE INDEX IF NOT EXISTS business_operation_room_links_pair_uidx ON business_operation_room_links (operation_id, substructure_id);

CREATE TABLE IF NOT EXISTS business_operation_documents (
  id            BIGSERIAL    PRIMARY KEY,
  account_id    INTEGER      NOT NULL,
  operation_id  BIGINT       NOT NULL,
  file_id       INTEGER      NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  origins       TEXT[]       NOT NULL DEFAULT '{}',
  active        BOOLEAN      GENERATED ALWAYS AS (cardinality(origins) > 0) STORED,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT business_operation_documents_operation_fk FOREIGN KEY (operation_id, account_id)
    REFERENCES business_operations (id, account_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT business_operation_documents_origins_chk CHECK (origins <@ ARRAY['SOURCE', 'USER']::text[])
);
CREATE UNIQUE INDEX IF NOT EXISTS business_operation_documents_pair_uidx ON business_operation_documents (operation_id, file_id);

-- Garde intercomptes : Pièce / document du compte de la ligne.
CREATE OR REPLACE FUNCTION business_operation_room_links_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_asset   INTEGER;
  v_account INTEGER;
BEGIN
  SELECT s.asset_id, a.account_id INTO v_asset, v_account
    FROM substructures s JOIN assets a ON a.id = s.asset_id WHERE s.id = NEW.substructure_id;
  IF v_asset IS NULL OR v_account IS DISTINCT FROM NEW.account_id THEN
    RAISE EXCEPTION 'CROSS_ACCOUNT_LINK: pièce % hors du compte % (business_operation_room_links)', NEW.substructure_id, NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.asset_id := v_asset;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS business_operation_room_links_guard ON business_operation_room_links;
CREATE TRIGGER business_operation_room_links_guard
  BEFORE INSERT OR UPDATE OF substructure_id ON business_operation_room_links
  FOR EACH ROW EXECUTE FUNCTION business_operation_room_links_guard();

CREATE OR REPLACE FUNCTION business_operation_documents_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM asset_files f WHERE f.id = NEW.file_id AND f.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'CROSS_ACCOUNT_LINK: document % hors du compte % (business_operation_documents)', NEW.file_id, NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS business_operation_documents_guard ON business_operation_documents;
CREATE TRIGGER business_operation_documents_guard
  BEFORE INSERT OR UPDATE OF file_id ON business_operation_documents
  FOR EACH ROW EXECUTE FUNCTION business_operation_documents_guard();

-- Appartenance SOURCE d'un (Opération, document) recalculée depuis les sources actives.
CREATE OR REPLACE FUNCTION business_operation_documents_refresh(p_account INTEGER, p_operation BIGINT, p_key TEXT) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  v_file INTEGER;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[1-9][0-9]{0,9}$' THEN RETURN; END IF;
  v_file := p_key::integer;
  IF EXISTS (SELECT 1 FROM business_operation_sources s
              WHERE s.operation_id = p_operation AND s.account_id = p_account AND s.active
                AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = p_key)
     AND EXISTS (SELECT 1 FROM asset_files f WHERE f.id = v_file AND f.account_id = p_account)
     AND EXISTS (SELECT 1 FROM business_operations o WHERE o.id = p_operation AND o.account_id = p_account) THEN
    INSERT INTO business_operation_documents (account_id, operation_id, file_id, origins)
    VALUES (p_account, p_operation, v_file, ARRAY['SOURCE']::text[])
    ON CONFLICT (operation_id, file_id) DO UPDATE
       SET origins = CASE WHEN 'SOURCE' = ANY(business_operation_documents.origins) THEN business_operation_documents.origins
                          ELSE business_operation_documents.origins || ARRAY['SOURCE']::text[] END,
           updated_at = CASE WHEN 'SOURCE' = ANY(business_operation_documents.origins) THEN business_operation_documents.updated_at ELSE now() END;
  ELSE
    UPDATE business_operation_documents
       SET origins = array_remove(origins, 'SOURCE'), updated_at = now()
     WHERE operation_id = p_operation AND file_id = v_file AND 'SOURCE' = ANY(origins);
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION business_operation_sources_documents_sync() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.source_kind = 'DOCUMENT' THEN
    PERFORM business_operation_documents_refresh(OLD.account_id, OLD.operation_id, OLD.source_entity_key);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.source_kind = 'DOCUMENT' THEN
    PERFORM business_operation_documents_refresh(NEW.account_id, NEW.operation_id, NEW.source_entity_key);
  END IF;
  RETURN NULL;
END
$fn$;
DROP TRIGGER IF EXISTS business_operation_sources_documents_sync ON business_operation_sources;
CREATE TRIGGER business_operation_sources_documents_sync
  AFTER INSERT OR DELETE OR UPDATE OF active, operation_id, account_id, source_entity_key, source_kind ON business_operation_sources
  FOR EACH ROW EXECUTE FUNCTION business_operation_sources_documents_sync();

-- Reprise : appartenance SOURCE depuis les sources DOCUMENT actives (rejouable).
INSERT INTO business_operation_documents (account_id, operation_id, file_id, origins)
SELECT DISTINCT s.account_id, s.operation_id, f.id, ARRAY['SOURCE']::text[]
  FROM business_operation_sources s
  JOIN asset_files f ON f.id::text = s.source_entity_key AND f.account_id = s.account_id
 WHERE s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key ~ '^[1-9][0-9]{0,9}$'
ON CONFLICT (operation_id, file_id) DO NOTHING;
