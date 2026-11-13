-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1690 : événements de référence — arbitrage T3 par l'IA d'une
-- contradiction RÉELLE d'attribut (lot 114, carte Trello #750, issue B ;
-- diagnostic de l'anomalie BO #12, carte #751).
--
-- `business_operation_attribute_arbitrations` (nouvelle) : DEMANDE, MÉMOIRE et
-- DÉCISION de l'examen T3 (opération `t3_attribute_arbitration`, branche
-- ATTRIBUTE_ARBITRATION du prompt maître T3, contrat
-- `t3-attribute-arbitration-v1`, bloc 38 du guide du PO) d'UNE ligne de
-- contradiction : même attribut (date prévue, de début, de réalisation, de fin,
-- prestataire), même rôle sémantique, valeurs incompatibles non tranchées.
--   · clé : empreinte STABLE de la ligne (événement, attribut, rôle, valeurs
--     normalisées), UNE ligne par compte et par empreinte — un constat déjà
--     examiné n'est jamais renvoyé à l'IA ; une valeur nouvelle est une autre
--     empreinte (réouverture motivée) ;
--   · demande (PENDING) posée par la consolidation T3, SANS appel IA, seulement
--     si le prompt T3 actif porte la branche et le marqueur ; traitée HORS
--     lecture par le passage T3 du compte, par lots bornés ;
--   · issue : valeur retenue sur preuve citée (RESOLVED), faits distincts
--     (DISTINCT_FACTS), indécidable (UNDECIDABLE : carte « À traiter »), document
--     étranger (LINK_ERROR), abstention, sortie refusée par la validation
--     (REJECTED), confiance insuffisante (NOT_CERTAIN), échec technique
--     (AI_FAILED, nouvel essai borné), ligne disparue (OBSOLETE), branche retirée
--     du prompt (UNAVAILABLE) ;
--   · trace : valeurs présentées, sortie reçue, validation, preuve citée
--     (document + extrait), valeur avant / après, version du prompt, identifiant
--     de trace de la passerelle.
-- Une décision de l'utilisateur (source USER_ARBITRATION de l'événement) prime
-- toujours ; aucune valeur n'est écrite par cette table (la consolidation la
-- relit et applique la valeur retenue sous les protections existantes).
--
-- Additive, idempotente, rejouable ; aucune reprise de données. Suppression du
-- compte ou de l'événement : cascade. Retour arrière : DROP TABLE
-- business_operation_attribute_arbitrations (la contradiction réelle revient
-- directement à la carte « À traiter »).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS business_operation_attribute_arbitrations (
  id                    BIGSERIAL    PRIMARY KEY,
  account_id            INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operation_id          BIGINT       NOT NULL REFERENCES business_operations(id) ON DELETE CASCADE,
  field                 TEXT         NOT NULL,
  role                  TEXT         NOT NULL,
  fingerprint           TEXT         NOT NULL,
  presented_values      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  file_ids              INTEGER[]    NOT NULL DEFAULT '{}',
  status                TEXT         NOT NULL DEFAULT 'PENDING',
  outcome               TEXT,
  retained_value        TEXT,
  retained_normalized   TEXT,
  foreign_file_id       INTEGER      REFERENCES asset_files(id) ON DELETE SET NULL,
  confidence            TEXT,
  evidence              JSONB        NOT NULL DEFAULT '[]'::jsonb,
  reason                TEXT,
  ai_output             JSONB,
  validation            JSONB        NOT NULL DEFAULT '{}'::jsonb,
  value_before          TEXT,
  value_after           TEXT,
  applied_at            TIMESTAMPTZ,
  contract_version      TEXT         NOT NULL,
  decider_version       TEXT,
  ai_trace_id           TEXT,
  ai_calls              INTEGER      NOT NULL DEFAULT 0,
  attempts              INTEGER      NOT NULL DEFAULT 0,
  retry_at              TIMESTAMPTZ,
  last_call_at          TIMESTAMPTZ,
  error                 TEXT,
  requested_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  decided_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_attribute_arbitrations_status_chk') THEN
    ALTER TABLE business_operation_attribute_arbitrations ADD CONSTRAINT business_operation_attribute_arbitrations_status_chk
      CHECK (status IN ('PENDING', 'DECIDED', 'ABSTAINED', 'REJECTED', 'NOT_CERTAIN', 'AI_FAILED', 'OBSOLETE', 'UNAVAILABLE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_attribute_arbitrations_outcome_chk') THEN
    ALTER TABLE business_operation_attribute_arbitrations ADD CONSTRAINT business_operation_attribute_arbitrations_outcome_chk
      CHECK (outcome IS NULL OR outcome IN ('RESOLVED', 'DISTINCT_FACTS', 'UNDECIDABLE', 'LINK_ERROR', 'ABSTAIN'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_attribute_arbitrations_field_chk') THEN
    ALTER TABLE business_operation_attribute_arbitrations ADD CONSTRAINT business_operation_attribute_arbitrations_field_chk
      CHECK (field IN ('plannedDate', 'startDate', 'realizedDate', 'endDate', 'provider'));
  END IF;
END $$;

-- Mémoire : une seule ligne par constat d'un compte (jamais renvoyé à l'IA une fois examiné).
CREATE UNIQUE INDEX IF NOT EXISTS business_operation_attribute_arbitrations_fp_uidx
  ON business_operation_attribute_arbitrations (account_id, fingerprint);
-- Lecture par la consolidation de l'événement de référence.
CREATE INDEX IF NOT EXISTS business_operation_attribute_arbitrations_op_idx
  ON business_operation_attribute_arbitrations (operation_id, id);
-- File du passage T3 (demandes en attente, nouveaux essais échus).
CREATE INDEX IF NOT EXISTS business_operation_attribute_arbitrations_queue_idx
  ON business_operation_attribute_arbitrations (account_id, id) WHERE status IN ('PENDING', 'AI_FAILED');
