-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0950 — lot 103E : fournisseurs / intervenants des éléments d'Agenda.
--
-- Ticket P1 « Agenda / Fournisseurs » : associer 0..n fournisseurs du
-- référentiel EXISTANT (`suppliers`) à tout élément d'Agenda, relation
-- bidirectionnelle persistante. Avant ce lot, aucune table ne reliait un
-- élément d'Agenda à un fournisseur : la fiche fournisseur DÉDUISAIT ses
-- « échéances » des documents et équipements liés (voisinage), ce que le
-- ticket interdit désormais.
--
--   1. agenda_item_suppliers : le lien (unique par couple élément ×
--      fournisseur), avec sa PROVENANCE / autorité :
--        USER      geste de l'utilisateur (tiroir Agenda, fiche fournisseur) ;
--        DOCUMENT  document DIRECTEMENT rattaché à l'élément dont le
--                  fournisseur est établi de façon fiable (moteur fournisseurs
--                  des documents) ;
--        AUTO      mention explicite et non ambiguë du fournisseur dans le
--                  libellé / la description de l'élément.
--      Un lien USER n'est jamais retiré par un traitement automatique.
--   2. agenda_item_supplier_suppressions : retrait MANUEL mémorisé (aucun
--      T3 / T4 / contrôle de cohérence ne recrée le lien) ; levé seulement
--      par un nouveau geste de l'utilisateur.
--   3. agenda_item_supplier_history : historique (provenance, auteur,
--      corrélation) des liens posés / retirés — traçabilité des réparations.
--
-- Intégrité : clés étrangères en cascade (élément, fournisseur, compte) —
-- aucun lien orphelin après suppression ou fusion ; déclencheur
-- `agenda_item_suppliers_same_account` : l'élément ET le fournisseur doivent
-- appartenir au compte de la ligne (aucun lien intercomptes possible, même par
-- une écriture directe).
--
-- Additive et idempotente. Retour arrière : l'ancien code ignore ces tables.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS agenda_item_suppliers (
  id bigserial PRIMARY KEY,
  account_id integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agenda_item_id integer NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  supplier_id integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  provenance text NOT NULL,
  evidence jsonb,
  source_document_id integer REFERENCES asset_files(id) ON DELETE SET NULL,
  created_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agenda_item_suppliers_provenance_check CHECK (provenance IN ('USER', 'DOCUMENT', 'AUTO')),
  CONSTRAINT agenda_item_suppliers_pair_key UNIQUE (agenda_item_id, supplier_id)
);
CREATE INDEX IF NOT EXISTS agenda_item_suppliers_supplier_idx ON agenda_item_suppliers (supplier_id);
CREATE INDEX IF NOT EXISTS agenda_item_suppliers_account_idx ON agenda_item_suppliers (account_id, agenda_item_id);

CREATE TABLE IF NOT EXISTS agenda_item_supplier_suppressions (
  id bigserial PRIMARY KEY,
  account_id integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agenda_item_id integer NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  supplier_id integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  previous_provenance text,
  suppressed_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  suppressed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agenda_item_supplier_suppressions_pair_key UNIQUE (agenda_item_id, supplier_id)
);
CREATE INDEX IF NOT EXISTS agenda_item_supplier_suppressions_supplier_idx ON agenda_item_supplier_suppressions (supplier_id);

CREATE TABLE IF NOT EXISTS agenda_item_supplier_history (
  id bigserial PRIMARY KEY,
  account_id integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agenda_item_id integer NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  supplier_id integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  action text NOT NULL,
  provenance text,
  actor_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  correlation_id text,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agenda_item_supplier_history_action_check CHECK (action IN ('LINKED', 'UNLINKED', 'SUPPRESSED', 'RESTORED', 'MERGED', 'PROVENANCE_UPGRADED'))
);
CREATE INDEX IF NOT EXISTS agenda_item_supplier_history_item_idx ON agenda_item_supplier_history (agenda_item_id, created_at DESC);

-- Aucun lien intercomptes : élément et fournisseur du compte de la ligne.
CREATE OR REPLACE FUNCTION agenda_item_suppliers_same_account() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM agenda_items i WHERE i.id = NEW.agenda_item_id AND i.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'AGENDA_SUPPLIER_CROSS_ACCOUNT: élément % hors du compte %', NEW.agenda_item_id, NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.id = NEW.supplier_id AND s.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'AGENDA_SUPPLIER_CROSS_ACCOUNT: fournisseur % hors du compte %', NEW.supplier_id, NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS agenda_item_suppliers_same_account ON agenda_item_suppliers;
CREATE TRIGGER agenda_item_suppliers_same_account
  BEFORE INSERT OR UPDATE OF account_id, agenda_item_id, supplier_id ON agenda_item_suppliers
  FOR EACH ROW EXECUTE FUNCTION agenda_item_suppliers_same_account();

DROP TRIGGER IF EXISTS agenda_item_supplier_suppressions_same_account ON agenda_item_supplier_suppressions;
CREATE TRIGGER agenda_item_supplier_suppressions_same_account
  BEFORE INSERT OR UPDATE OF account_id, agenda_item_id, supplier_id ON agenda_item_supplier_suppressions
  FOR EACH ROW EXECUTE FUNCTION agenda_item_suppliers_same_account();

COMMENT ON TABLE agenda_item_suppliers IS
  'Lot 103E : fournisseurs / intervenants d''un élément d''Agenda (référentiel suppliers), provenance USER / DOCUMENT / AUTO.';
COMMENT ON TABLE agenda_item_supplier_suppressions IS
  'Lot 103E : retrait manuel d''un fournisseur d''un élément d''Agenda — jamais recréé automatiquement.';
COMMENT ON TABLE agenda_item_supplier_history IS
  'Lot 103E : historique des liens Agenda ↔ fournisseur (provenance, auteur, corrélation).';
