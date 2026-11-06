-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1470 : fournisseurs — création automatique, arbitrage des seuls
-- doublons plausibles (lot 113G, ticket #706).
--
-- On SÉPARE explicitement :
--   (a) la création d'une fiche (inchangée : `suppliers`) ;
--   (b) la preuve du lien document → fournisseur : `document_suppliers`
--       garde `is_confirmed` / `confidence_score` (fiabilité RÉELLE, jamais
--       promue) et reçoit `match_basis`, la base du rattachement :
--         NEW_SUPPLIER   fiche créée depuis ce document, aucun candidat crédible ;
--         IDENTIFIER     fiche existante, SIRET / SIREN / TVA identiques ;
--         EXACT_NAME     fiche existante, même raison sociale normalisée, aucun
--                        identifiant contradictoire ;
--         UNCERTAIN_NEW  fiche créée, doublon PLAUSIBLE soumis à l'utilisateur ;
--         USER           rattachement choisi par l'utilisateur ;
--         MERGED         lien reporté par une fusion décidée par l'utilisateur.
--       NULL : lien antérieur (aucune requalification sans preuve) ;
--   (c) le soupçon de doublon entre deux fiches : `supplier_review_items`
--       (item_type = 'deduplication', inchangé) ;
--   (d) la décision humaine sur une PAIRE de fiches :
--       `supplier_identity_decisions` (nouvelle), paire normalisée NON
--       ORDONNÉE (plus petit identifiant d'abord), SAME (fusion) ou DISTINCT
--       (identités différentes, protégée contre les réanalyses T1 / T3 et la
--       cohérence ; réouverture seulement sur preuve objective nouvelle,
--       motif tracé).
--   + `suppliers.merged_into_supplier_id` : fiche conservée après une fusion
--     (identifiant de référence retrouvé, jamais de lien perdu).
--
-- Additive, idempotente, rejouable ; aucune reprise de données (le stock est
-- traité par le contrôle de cohérence COH-SUPPLIER-IDENTITY).
-- Retour arrière : DROP TABLE supplier_identity_decisions ; DROP COLUMN
-- document_suppliers.match_basis, suppliers.merged_into_supplier_id ;
-- DROP FUNCTION supplier_identity_decisions_same_account().
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE document_suppliers ADD COLUMN IF NOT EXISTS match_basis TEXT;
ALTER TABLE document_suppliers DROP CONSTRAINT IF EXISTS document_suppliers_match_basis_chk;
ALTER TABLE document_suppliers ADD CONSTRAINT document_suppliers_match_basis_chk
  CHECK (match_basis IS NULL OR match_basis IN ('NEW_SUPPLIER', 'IDENTIFIER', 'EXACT_NAME', 'UNCERTAIN_NEW', 'USER', 'MERGED')) NOT VALID;
ALTER TABLE document_suppliers VALIDATE CONSTRAINT document_suppliers_match_basis_chk;

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS merged_into_supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS supplier_identity_decisions (
  id bigserial PRIMARY KEY,
  account_id integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  supplier_low_id integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  supplier_high_id integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  decision text NOT NULL,
  basis text,
  evidence_fingerprint text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_id integer REFERENCES supplier_review_items(id) ON DELETE SET NULL,
  decided_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  reopened_at timestamptz,
  reopen_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_identity_decisions_pair_chk CHECK (supplier_low_id < supplier_high_id),
  CONSTRAINT supplier_identity_decisions_decision_chk CHECK (decision IN ('SAME', 'DISTINCT')),
  CONSTRAINT supplier_identity_decisions_evidence_chk CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT supplier_identity_decisions_pair_key UNIQUE (account_id, supplier_low_id, supplier_high_id)
);
CREATE INDEX IF NOT EXISTS supplier_identity_decisions_high_idx ON supplier_identity_decisions (supplier_high_id);

-- Aucune décision intercomptes : les deux fiches appartiennent au compte de la ligne.
CREATE OR REPLACE FUNCTION supplier_identity_decisions_same_account() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF (SELECT count(*) FROM suppliers s WHERE s.id IN (NEW.supplier_low_id, NEW.supplier_high_id) AND s.account_id = NEW.account_id) <> 2 THEN
    RAISE EXCEPTION 'SUPPLIER_IDENTITY_CROSS_ACCOUNT: paire % / % hors du compte %', NEW.supplier_low_id, NEW.supplier_high_id, NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS supplier_identity_decisions_same_account ON supplier_identity_decisions;
CREATE TRIGGER supplier_identity_decisions_same_account
  BEFORE INSERT OR UPDATE OF account_id, supplier_low_id, supplier_high_id ON supplier_identity_decisions
  FOR EACH ROW EXECUTE FUNCTION supplier_identity_decisions_same_account();

COMMENT ON COLUMN document_suppliers.match_basis IS
  'Lot 113G : base du rattachement (NEW_SUPPLIER, IDENTIFIER, EXACT_NAME, UNCERTAIN_NEW, USER, MERGED) — distincte de is_confirmed / confidence_score (fiabilité réelle, jamais promue).';
COMMENT ON COLUMN suppliers.merged_into_supplier_id IS
  'Lot 113G : fiche conservée après une fusion décidée par l''utilisateur (identifiant de référence).';
COMMENT ON TABLE supplier_identity_decisions IS
  'Lot 113G : décision de l''utilisateur sur une PAIRE de fiches fournisseur (paire non ordonnée, SAME = fusion, DISTINCT = identités différentes) — respectée par T1, T3, la cohérence et les nouveaux documents ; réouverture seulement sur preuve objective nouvelle (motif tracé).';
