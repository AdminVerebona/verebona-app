-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1100 — lot 109A : relation Opération ↔ fournisseur (ticket P1
-- « Relations métier — Unifier Opérations, documents, équipements,
-- fournisseurs et Agenda », §4).
--
-- AUDIT DE L'EXISTANT (avant migration) : aucune table ne relie une Opération
-- à une fiche du référentiel `suppliers`. L'Opération ne porte que la
-- DÉSIGNATION textuelle de son prestataire (`business_operations.provider`,
-- marque ou raison sociale telle que lue) ; les liens existants sont
-- document ↔ fournisseur (`document_suppliers`, émetteur légal du document),
-- équipement ↔ fournisseur (`equipment_suppliers`), bien ↔ fournisseur
-- (`asset_suppliers`) et élément d'Agenda ↔ fournisseur
-- (`agenda_item_suppliers`, lot 103E). Les équivalences de désignations
-- (`provider-equivalence.ts`, lot 86C) sont CALCULÉES, jamais persistées.
-- Cette table n'en double donc aucune : elle porte le seul fait manquant,
-- « ce fournisseur est partie de cette réalité métier », avec rôle,
-- provenance, preuve et état.
--
--   1. business_operation_suppliers : UNE ligne par couple Opération ×
--      fournisseur (unique, quel que soit l'état) :
--        role    PROVIDER         fournisseur de l'Opération (sa fiche est
--                                 celle de l'émetteur d'un document de
--                                 l'Opération qui désigne le prestataire de
--                                 l'Opération) ;
--                DOCUMENT_ISSUER  émetteur légal d'un document de l'Opération
--                                 qui n'en est pas le prestataire ;
--                INTERVENER / BRAND  rôles posés par l'utilisateur seulement ;
--        origin  T3 (preuve documentaire, moteur de consolidation) | USER ;
--        status  ACTIVE | REMOVED (retrait automatique : preuve disparue,
--                fusion, intercomptes — rétablissable par une preuve) |
--                REJECTED (refus ou retrait de l'utilisateur : JAMAIS
--                rétabli automatiquement) ;
--        evidence  documents et sources qui prouvent le lien (règle, version).
--   2. business_operation_supplier_history : toute évolution (posé, mis à
--      jour, retiré, rétabli, refusé, transféré par fusion), avec motif,
--      provenance, auteur et corrélation.
--
-- Intégrité : clé composée (Opération, compte) en cascade — la ligne suit
-- toujours le compte de son Opération ; fournisseur en cascade ; déclencheur
-- `business_operation_suppliers_same_account` : le fournisseur appartient au
-- compte de la ligne (aucun lien intercomptes, même par une écriture directe).
-- Le déclencheur ne porte PAS sur `account_id` / `operation_id` : le
-- transfert d'un bien (Duo) déplace l'Opération en cascade et le lien
-- devenu intercomptes est retiré dans la même transaction
-- (`detachCrossAccountGroupingInTx`).
--
-- Aucun déclencheur d'écriture (anti-boucle C16.2). Additive, idempotente,
-- rejouable. Retour arrière : l'ancien code ignore ces tables.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS business_operation_suppliers (
  id bigserial PRIMARY KEY,
  account_id integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operation_id bigint NOT NULL,
  supplier_id integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  role text NOT NULL,
  origin text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason_code text,
  decided_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_operation_suppliers_operation_fk FOREIGN KEY (operation_id, account_id)
    REFERENCES business_operations (id, account_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT business_operation_suppliers_role_chk CHECK (role IN ('PROVIDER', 'DOCUMENT_ISSUER', 'INTERVENER', 'BRAND')),
  CONSTRAINT business_operation_suppliers_origin_chk CHECK (origin IN ('T3', 'USER')),
  CONSTRAINT business_operation_suppliers_status_chk CHECK (status IN ('ACTIVE', 'REMOVED', 'REJECTED')),
  CONSTRAINT business_operation_suppliers_evidence_chk CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT business_operation_suppliers_pair_key UNIQUE (operation_id, supplier_id)
);
CREATE INDEX IF NOT EXISTS business_operation_suppliers_supplier_idx
  ON business_operation_suppliers (supplier_id, operation_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS business_operation_suppliers_account_idx
  ON business_operation_suppliers (account_id, status);

CREATE TABLE IF NOT EXISTS business_operation_supplier_history (
  id bigserial PRIMARY KEY,
  account_id integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operation_id bigint NOT NULL,
  supplier_id integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  action text NOT NULL,
  role text,
  origin text,
  reason_code text NOT NULL,
  actor_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  correlation_id text,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_operation_supplier_history_operation_fk FOREIGN KEY (operation_id, account_id)
    REFERENCES business_operations (id, account_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT business_operation_supplier_history_action_chk
    CHECK (action IN ('LINKED', 'UPDATED', 'REMOVED', 'RESTORED', 'REJECTED', 'TRANSFERRED'))
);
CREATE INDEX IF NOT EXISTS business_operation_supplier_history_operation_idx
  ON business_operation_supplier_history (operation_id, created_at);
CREATE INDEX IF NOT EXISTS business_operation_supplier_history_account_idx
  ON business_operation_supplier_history (account_id, created_at);

-- Aucun lien intercomptes : le fournisseur appartient au compte de la ligne.
CREATE OR REPLACE FUNCTION business_operation_suppliers_same_account() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.id = NEW.supplier_id AND s.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'OPERATION_SUPPLIER_CROSS_ACCOUNT: fournisseur % hors du compte %', NEW.supplier_id, NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS business_operation_suppliers_same_account ON business_operation_suppliers;
CREATE TRIGGER business_operation_suppliers_same_account
  BEFORE INSERT OR UPDATE OF supplier_id ON business_operation_suppliers
  FOR EACH ROW EXECUTE FUNCTION business_operation_suppliers_same_account();

COMMENT ON TABLE business_operation_suppliers IS
  'Lot 109A : fournisseurs (référentiel suppliers) d''une Opération — rôle, provenance T3 / USER, preuve, état ACTIVE / REMOVED / REJECTED.';
COMMENT ON TABLE business_operation_supplier_history IS
  'Lot 109A : historique des liens Opération ↔ fournisseur (action, motif, provenance, auteur, corrélation, avant / après).';
