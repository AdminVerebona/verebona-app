-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1716 : graphe canonique des événements de référence — LIENS N↔N
-- événement de référence ↔ élément d'Agenda, SANS rôle « principal »
-- (lot 114O, carte Trello #744, CDC « Opérations / Agenda V2.0 » §4, §12, §16,
-- §22, lot B).
--
-- AVANT : un élément d'Agenda appartient à AU PLUS UNE Opération
-- (`agenda_items.business_operation_id`) et l'identité visible de l'Opération
-- passe par le rôle PRINCIPAL / RELATED de cette colonne.
-- CIBLE : lien facultatif des deux côtés, N↔N, sans « principal ».
--
-- `business_operation_agenda_links` (nouvelle) : UNE ligne par couple
-- (Opération, élément d'Agenda) — aucun doublon possible, aucune colonne de
-- rôle. Un élément partagé par deux Opérations reste UN SEUL élément d'Agenda
-- (une seule ligne `agenda_items`, un seul rappel) : seule la table de liens
-- porte la seconde relation.
--   · `state` : ACTIVE | REMOVED. Le REFUS de l'utilisateur reste porté par la
--     mémoire existante `business_operation_match_decisions` (objet AGENDA,
--     REJECTED) — une seule source de vérité des refus, déjà remappée à la
--     fusion et protégée par la reconstruction ;
--   · `origin` : USER, AI, MIGRATION, SYSTEM ;
--   · `legacy_column` : le lien est AUSSI porté par la colonne historique
--     `agenda_items.business_operation_id` (il la suit) ; faux pour un lien
--     supplémentaire qui n'existe que dans le graphe ;
--   · `evidence`, `version`, `decided_by_user_id`, `decided_at`, `ended_at`.
--
-- COMPATIBILITÉ (pas de bascule brutale) : la colonne historique reste écrite
-- par le service unique de regroupement et lue par les écrans existants
-- (Timeline, tiroirs, projection T4). Le déclencheur
-- `agenda_items_operation_link_sync` (APRÈS écriture de la colonne, quel que
-- soit le chemin : regroupement, fusion, purge, restauration) tient le lien du
-- graphe à l'identique : colonne posée → lien ACTIVE (`legacy_column`),
-- colonne retirée ou déplacée → lien REMOVED. Le graphe contient donc TOUJOURS
-- les liens de la colonne (jamais deux vérités), plus les liens
-- supplémentaires. Il ne lève jamais d'erreur (un couple entre comptes,
-- transitoire pendant un transfert de bien, n'est simplement pas reflété).
--
-- INTÉGRITÉ : aucun lien ACTIVE entre comptes (déclencheur
-- `business_operation_agenda_links_account_guard`).
--
-- REPRISE DÉTERMINISTE (aucune décision nouvelle, rejouable sans effet) : chaque
-- couple porté aujourd'hui par la colonne devient un lien ACTIVE d'origine
-- MIGRATION. Aucun événement n'est créé, modifié, daté ni supprimé ; aucun
-- rappel n'est touché ; aucun rôle n'est lu ni écrit.
--
-- Additive, idempotente. Suppression du compte, de l'Opération ou de l'élément :
-- cascade. Retour arrière : DROP TRIGGER agenda_items_operation_link_sync ON
-- agenda_items ; DROP FUNCTION agenda_items_operation_link_sync() ; DROP TABLE
-- business_operation_agenda_links ; DROP FUNCTION
-- business_operation_agenda_links_account_guard() — la colonne historique,
-- intacte, reste la référence des écrans existants.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS business_operation_agenda_links (
  id                    BIGSERIAL    PRIMARY KEY,
  account_id            INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operation_id          BIGINT       NOT NULL REFERENCES business_operations(id) ON DELETE CASCADE,
  agenda_item_id        INTEGER      NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  state                 TEXT         NOT NULL DEFAULT 'ACTIVE',
  origin                TEXT         NOT NULL,
  legacy_column         BOOLEAN      NOT NULL DEFAULT false,
  reason_code           TEXT         NOT NULL,
  evidence              JSONB        NOT NULL DEFAULT '[]'::jsonb,
  version               INTEGER      NOT NULL DEFAULT 1,
  decided_by_user_id    INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  decided_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ended_at              TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_agenda_links_state_chk') THEN
    ALTER TABLE business_operation_agenda_links ADD CONSTRAINT business_operation_agenda_links_state_chk
      CHECK (state IN ('ACTIVE', 'REMOVED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_agenda_links_origin_chk') THEN
    ALTER TABLE business_operation_agenda_links ADD CONSTRAINT business_operation_agenda_links_origin_chk
      CHECK (origin IN ('USER', 'AI', 'MIGRATION', 'SYSTEM'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_agenda_links_evidence_chk') THEN
    ALTER TABLE business_operation_agenda_links ADD CONSTRAINT business_operation_agenda_links_evidence_chk
      CHECK (jsonb_typeof(evidence) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_agenda_links_version_chk') THEN
    ALTER TABLE business_operation_agenda_links ADD CONSTRAINT business_operation_agenda_links_version_chk
      CHECK (version >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_agenda_links_lifecycle_chk') THEN
    ALTER TABLE business_operation_agenda_links ADD CONSTRAINT business_operation_agenda_links_lifecycle_chk
      CHECK ((state = 'ACTIVE') = (ended_at IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_agenda_links_legacy_chk') THEN
    ALTER TABLE business_operation_agenda_links ADD CONSTRAINT business_operation_agenda_links_legacy_chk
      CHECK (NOT legacy_column OR state = 'ACTIVE');
  END IF;
END $$;

-- UN lien par couple (Opération, élément) : aucun doublon.
CREATE UNIQUE INDEX IF NOT EXISTS business_operation_agenda_links_pair_uidx
  ON business_operation_agenda_links (operation_id, agenda_item_id);
-- Lecture symétrique : Opérations d'un élément, bornée au compte.
CREATE INDEX IF NOT EXISTS business_operation_agenda_links_item_idx
  ON business_operation_agenda_links (account_id, agenda_item_id, state);
-- Lecture des éléments d'une Opération.
CREATE INDEX IF NOT EXISTS business_operation_agenda_links_operation_idx
  ON business_operation_agenda_links (account_id, operation_id, state);

-- Filet : aucun lien ACTIVE entre deux comptes.
CREATE OR REPLACE FUNCTION business_operation_agenda_links_account_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.state = 'ACTIVE' AND (
       NOT EXISTS (SELECT 1 FROM business_operations o WHERE o.id = NEW.operation_id AND o.account_id = NEW.account_id)
    OR NOT EXISTS (SELECT 1 FROM agenda_items i WHERE i.id = NEW.agenda_item_id AND i.account_id = NEW.account_id)) THEN
    RAISE EXCEPTION 'business_operation_agenda_links : lien entre comptes refusé (compte %, opération %, élément %)',
      NEW.account_id, NEW.operation_id, NEW.agenda_item_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS business_operation_agenda_links_account_guard ON business_operation_agenda_links;
CREATE TRIGGER business_operation_agenda_links_account_guard
  BEFORE INSERT OR UPDATE OF account_id, operation_id, agenda_item_id, state ON business_operation_agenda_links
  FOR EACH ROW EXECUTE FUNCTION business_operation_agenda_links_account_guard();

-- Compatibilité : le graphe suit la colonne historique, quel que soit le chemin d'écriture.
CREATE OR REPLACE FUNCTION agenda_items_operation_link_sync() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.business_operation_id IS NOT DISTINCT FROM NEW.business_operation_id THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.business_operation_id IS NOT NULL THEN
    UPDATE business_operation_agenda_links
       SET state = 'REMOVED', legacy_column = false, ended_at = now(), version = version + 1, updated_at = now(),
           reason_code = 'LEGACY_COLUMN_DETACHED'
     WHERE operation_id = OLD.business_operation_id AND agenda_item_id = NEW.id AND state = 'ACTIVE' AND legacy_column;
  END IF;
  IF NEW.business_operation_id IS NOT NULL THEN
    INSERT INTO business_operation_agenda_links (account_id, operation_id, agenda_item_id, state, origin, legacy_column, reason_code)
    SELECT NEW.account_id, o.id, NEW.id, 'ACTIVE',
           CASE NEW.operation_role_origin WHEN 'USER' THEN 'USER' WHEN 'T4' THEN 'AI' WHEN 'T3' THEN 'AI' ELSE 'SYSTEM' END,
           true, 'LEGACY_COLUMN_ATTACHED'
      FROM business_operations o
     WHERE o.id = NEW.business_operation_id AND o.account_id = NEW.account_id
    ON CONFLICT (operation_id, agenda_item_id) DO UPDATE
       SET state = 'ACTIVE', legacy_column = true, ended_at = NULL, account_id = EXCLUDED.account_id,
           origin = CASE WHEN business_operation_agenda_links.state = 'ACTIVE' THEN business_operation_agenda_links.origin ELSE EXCLUDED.origin END,
           reason_code = CASE WHEN business_operation_agenda_links.state = 'ACTIVE' THEN business_operation_agenda_links.reason_code ELSE EXCLUDED.reason_code END,
           version = business_operation_agenda_links.version + 1, updated_at = now()
     WHERE NOT (business_operation_agenda_links.state = 'ACTIVE' AND business_operation_agenda_links.legacy_column);
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS agenda_items_operation_link_sync ON agenda_items;
CREATE TRIGGER agenda_items_operation_link_sync
  AFTER INSERT OR UPDATE OF business_operation_id ON agenda_items
  FOR EACH ROW EXECUTE FUNCTION agenda_items_operation_link_sync();

-- Reprise déterministe : couples portés par la colonne historique (même compte seulement).
INSERT INTO business_operation_agenda_links (account_id, operation_id, agenda_item_id, state, origin, legacy_column, reason_code)
SELECT ai.account_id, o.id, ai.id, 'ACTIVE', 'MIGRATION', true, 'MIGRATION_1716_LEGACY_COLUMN'
  FROM agenda_items ai
  JOIN business_operations o ON o.id = ai.business_operation_id AND o.account_id = ai.account_id
 WHERE ai.business_operation_id IS NOT NULL
ON CONFLICT (operation_id, agenda_item_id) DO NOTHING;
