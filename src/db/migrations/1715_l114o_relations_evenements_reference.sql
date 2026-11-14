-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1715 : graphe canonique des événements de référence — RELATIONS
-- événement de référence ↔ événement de référence (lot 114O, carte Trello #744,
-- CDC « Opérations / Agenda V2.0 » §4, §7, §9, lot B).
--
-- `business_operation_relations` (nouvelle) : ASSOCIATION persistante entre deux
-- Opérations DISTINCTES du même compte (financement ↔ acquisition, sinistre ↔
-- réparation, association non qualifiée). Ce n'est NI une fusion (les deux
-- identités restent), NI une hiérarchie parent / enfant (aucune colonne de
-- parent n'est réintroduite), NI une allocation financière (aucune composante,
-- aucun montant, aucune date n'est créé par une relation).
--   · UNE ligne par PAIRE non ordonnée d'Opérations (index unique sur
--     LEAST / GREATEST) : aucun doublon actif possible, lectures symétriques ;
--   · `nature` : FINANCING (de = le financement, vers = ce qu'il finance),
--     CLAIM_REPAIR (de = le sinistre, vers = la réparation), ASSOCIATED (lien non
--     orienté, nature non prouvée) ;
--   · `state` : ACTIVE, REMOVED (retirée sans refus : transfert de compte,
--     fusion, preuve retirée), REJECTED (REFUS de l'utilisateur : durable, jamais
--     réactivé par une inférence, une migration ou un contrôle) ;
--   · `origin` : USER, AI (T2 / T3 / T4), MIGRATION, SYSTEM ;
--   · `evidence` (preuves citées), `evidence_fingerprint` (empreinte des preuves
--     au moment de la décision : une même preuve rejetée n'est jamais reproposée),
--     `version` (verrou optimiste de la relation), `valid_from` / `valid_to`
--     (validité métier quand elle est prouvée — jamais une date de traitement),
--     `decided_by_user_id`, `decided_at`, `ended_at`.
-- L'historique complet (avant / après, auteur, commande) est dans
-- `business_operation_graph_history` (1717).
--
-- INTÉGRITÉ (filet de la base, quel que soit le chemin d'écriture) :
--   · aucune relation réflexive (CHECK) ;
--   · aucune relation ACTIVE entre deux comptes : déclencheur
--     `business_operation_relations_account_guard` (les deux Opérations doivent
--     appartenir au compte de la relation). Le déplacement d'un bien entre
--     comptes déplace les Opérations en plusieurs étapes : la relation n'est
--     pas liée par une clé composée ; elle est suivie ou retirée par
--     `detachCrossAccountGraphInTx` dans la même transaction.
--
-- Additive, idempotente, rejouable ; AUCUNE reprise de données (aucune relation
-- n'est déduite du stock : ni prêt ni acquisition fictifs). Suppression du
-- compte ou d'une Opération : cascade. Retour arrière : DROP TABLE
-- business_operation_relations ; DROP FUNCTION
-- business_operation_relations_account_guard() — aucune lecture existante n'en
-- dépend.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS business_operation_relations (
  id                    BIGSERIAL    PRIMARY KEY,
  account_id            INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  from_operation_id     BIGINT       NOT NULL REFERENCES business_operations(id) ON DELETE CASCADE,
  to_operation_id       BIGINT       NOT NULL REFERENCES business_operations(id) ON DELETE CASCADE,
  nature                TEXT         NOT NULL,
  state                 TEXT         NOT NULL DEFAULT 'ACTIVE',
  origin                TEXT         NOT NULL,
  reason_code           TEXT         NOT NULL,
  evidence              JSONB        NOT NULL DEFAULT '[]'::jsonb,
  evidence_fingerprint  TEXT,
  version               INTEGER      NOT NULL DEFAULT 1,
  valid_from            DATE,
  valid_to              DATE,
  decided_by_user_id    INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  decided_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ended_at              TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_relations_not_self_chk') THEN
    ALTER TABLE business_operation_relations ADD CONSTRAINT business_operation_relations_not_self_chk
      CHECK (from_operation_id <> to_operation_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_relations_nature_chk') THEN
    ALTER TABLE business_operation_relations ADD CONSTRAINT business_operation_relations_nature_chk
      CHECK (nature IN ('FINANCING', 'CLAIM_REPAIR', 'ASSOCIATED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_relations_state_chk') THEN
    ALTER TABLE business_operation_relations ADD CONSTRAINT business_operation_relations_state_chk
      CHECK (state IN ('ACTIVE', 'REMOVED', 'REJECTED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_relations_origin_chk') THEN
    ALTER TABLE business_operation_relations ADD CONSTRAINT business_operation_relations_origin_chk
      CHECK (origin IN ('USER', 'AI', 'MIGRATION', 'SYSTEM'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_relations_evidence_chk') THEN
    ALTER TABLE business_operation_relations ADD CONSTRAINT business_operation_relations_evidence_chk
      CHECK (jsonb_typeof(evidence) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_relations_version_chk') THEN
    ALTER TABLE business_operation_relations ADD CONSTRAINT business_operation_relations_version_chk
      CHECK (version >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_relations_lifecycle_chk') THEN
    ALTER TABLE business_operation_relations ADD CONSTRAINT business_operation_relations_lifecycle_chk
      CHECK ((state = 'ACTIVE') = (ended_at IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_relations_validity_chk') THEN
    ALTER TABLE business_operation_relations ADD CONSTRAINT business_operation_relations_validity_chk
      CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from);
  END IF;
END $$;

-- UNE relation par paire non ordonnée : aucun doublon, lecture symétrique.
CREATE UNIQUE INDEX IF NOT EXISTS business_operation_relations_pair_uidx
  ON business_operation_relations (LEAST(from_operation_id, to_operation_id), GREATEST(from_operation_id, to_operation_id));
-- Lectures par extrémité (les deux sens), bornées au compte.
CREATE INDEX IF NOT EXISTS business_operation_relations_from_idx
  ON business_operation_relations (account_id, from_operation_id, state);
CREATE INDEX IF NOT EXISTS business_operation_relations_to_idx
  ON business_operation_relations (account_id, to_operation_id, state);

-- Filet : aucune relation ACTIVE entre deux comptes.
CREATE OR REPLACE FUNCTION business_operation_relations_account_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.state = 'ACTIVE' AND (
       NOT EXISTS (SELECT 1 FROM business_operations o WHERE o.id = NEW.from_operation_id AND o.account_id = NEW.account_id)
    OR NOT EXISTS (SELECT 1 FROM business_operations o WHERE o.id = NEW.to_operation_id AND o.account_id = NEW.account_id)) THEN
    RAISE EXCEPTION 'business_operation_relations : relation entre comptes refusée (compte %, % -> %)',
      NEW.account_id, NEW.from_operation_id, NEW.to_operation_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS business_operation_relations_account_guard ON business_operation_relations;
CREATE TRIGGER business_operation_relations_account_guard
  BEFORE INSERT OR UPDATE OF account_id, from_operation_id, to_operation_id, state ON business_operation_relations
  FOR EACH ROW EXECUTE FUNCTION business_operation_relations_account_guard();
