-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1718 : DÉCLARATION de l'utilisateur comme source durable d'un
-- événement de référence (lot 114O, carte Trello #744, CDC « Opérations / Agenda
-- V2.0 » §2, §5, §6, AC01 ; lot B — façade d'écriture, commandes W21 / W22 de la
-- carte #753).
--
-- CDC §5 : « toute opération active doit avoir un fondement durable : […]
-- déclaration T2 enregistrée ». §6 : « la déclaration est persistée comme
-- source minimale avec texte utile, auteur, horodatage et rattachement au
-- compte, sans obligation d'archiver toute la conversation ».
--
-- 1. `business_operation_declarations` (nouvelle) : UNE ligne par déclaration
--    de l'utilisateur qui FONDE un événement de référence (création) ou qui en
--    CORRIGE un fait (modification) : texte utile (borné), auteur, canal,
--    horodatage, empreinte du texte normalisé (une même déclaration rejouée ne
--    fonde pas un second événement), Opération fondée ou corrigée.
--    La ligne SUIT son Opération (clé composée `(operation_id, account_id)`,
--    ON UPDATE CASCADE : transfert d'un bien ; ON DELETE CASCADE). Aucun
--    contenu de conversation, aucun document : le texte utile seulement.
-- 2. `business_operation_sources.source_kind` accepte la nature
--    `USER_DECLARATION` (clé de la source = `business_operation_declarations.id`).
--    La contrainte CHECK est ÉLARGIE (même méthode que 0656 / 0684 / 0736 pour
--    `business_operation_match_decisions`) : toutes les valeurs existantes
--    restent admises, aucune ligne existante n'est modifiée ni rejetée.
--
-- Aucune reprise de données : aucune déclaration n'est déduite du stock, aucun
-- événement de référence n'est créé, daté ni modifié par cette migration.
-- Additive, idempotente, rejouable. Retour arrière : invalider (BO) les
-- Opérations fondées sur une déclaration seule si le code revient en arrière,
-- puis reposer la liste de 0316 et DROP TABLE business_operation_declarations
-- (aucune lecture existante n'en dépend).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS business_operation_declarations (
  id                    BIGSERIAL    PRIMARY KEY,
  account_id            INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operation_id          BIGINT,
  purpose               TEXT         NOT NULL,
  channel               TEXT         NOT NULL,
  author_user_id        INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  declaration_text      TEXT         NOT NULL,
  fingerprint           TEXT         NOT NULL,
  declared_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_declarations_operation_fk') THEN
    ALTER TABLE business_operation_declarations ADD CONSTRAINT business_operation_declarations_operation_fk
      FOREIGN KEY (operation_id, account_id) REFERENCES business_operations(id, account_id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_declarations_purpose_chk') THEN
    ALTER TABLE business_operation_declarations ADD CONSTRAINT business_operation_declarations_purpose_chk
      CHECK (purpose IN ('CREATE', 'UPDATE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_declarations_channel_chk') THEN
    ALTER TABLE business_operation_declarations ADD CONSTRAINT business_operation_declarations_channel_chk
      CHECK (channel IN ('UI', 'TO_PROCESS', 'ASSISTANT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_declarations_text_chk') THEN
    ALTER TABLE business_operation_declarations ADD CONSTRAINT business_operation_declarations_text_chk
      CHECK (char_length(btrim(declaration_text)) BETWEEN 1 AND 2000);
  END IF;
END $$;

-- Déclarations d'une Opération ; recherche d'une déclaration identique déjà enregistrée (par compte).
CREATE INDEX IF NOT EXISTS business_operation_declarations_operation_idx
  ON business_operation_declarations (account_id, operation_id);
CREATE INDEX IF NOT EXISTS business_operation_declarations_fingerprint_idx
  ON business_operation_declarations (account_id, purpose, fingerprint);

-- Nature de source USER_DECLARATION : contrainte élargie (toutes les valeurs existantes conservées).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'business_operation_sources'::regclass
              AND conname = 'business_operation_sources_kind_chk' AND pg_get_constraintdef(oid) NOT LIKE '%USER_DECLARATION%') THEN
    ALTER TABLE business_operation_sources DROP CONSTRAINT business_operation_sources_kind_chk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'business_operation_sources'::regclass
                  AND conname = 'business_operation_sources_kind_chk') THEN
    ALTER TABLE business_operation_sources ADD CONSTRAINT business_operation_sources_kind_chk
      CHECK (source_kind IN ('DOCUMENT', 'ASSET_DATA', 'EQUIPMENT_DATA', 'AGENDA', 'CLAIM_FORM', 'USER_ARBITRATION', 'MIGRATION', 'USER_DECLARATION'));
  END IF;
END $$;
