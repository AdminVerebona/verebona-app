-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0317 : candidats T1, mémoire de rapprochement et données
-- spécifiques des Opérations (lot 39, O1 — CDC Opérations V1 C3.2, C6.3,
-- C13, C14, C20).
--
--   · document_operation_candidates : hypothèses documentaires T1 persistées
--     et versionnées (C3.2) — artefact d'extraction, pas une Opération ;
--     alimentées au lot T1, lues par T3 ;
--   · business_operation_match_decisions : décisions CONFIRMED / REJECTED
--     durables (C6.3) ;
--   · détails CONTRACT / FINANCING / CLAIM (C13) et listes structurées du
--     Sinistre : dommages (+ pièces et photos), actions, échanges (C14).
--     Plusieurs sinistres par bien et sinistre multi-biens (décision PO Q2) :
--     le Sinistre est une Opération CLAIM, ses biens sont des liens.
--     Un contrat signé à effet futur reste ENVISAGED jusqu'à son entrée en
--     vigueur (Q13) : `effective_from` le porte, le statut est sur l'Opération.
--
-- Les tables de détail sont rattachées à l'Opération par `operation_id`
-- (clé étrangère vers une Opération scopée au compte, C25) ; les références
-- croisées (contrat d'assurance, fichiers, photos) sont contrôlées
-- applicativement (même compte, C20.1).
--
-- Montants ≥ 0 en unités mineures (euros, centimes) ; aucune table TCO
-- (hors de ce CDC). Idempotente ; expand seulement. Index non uniques :
-- fichiers `0317_business_operation_details_idx_N` (CONCURRENTLY).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

-- ── Candidats T1 (C3.2) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_operation_candidates (
  id              BIGSERIAL    PRIMARY KEY,
  account_id      INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id         INTEGER      NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  extraction_id   INTEGER      NOT NULL REFERENCES document_extractions(id) ON DELETE CASCADE,
  analysis_run_id INTEGER,
  candidate_key   TEXT         NOT NULL,
  established     BOOLEAN      NOT NULL,
  confidence      TEXT         NOT NULL,
  type_hint       TEXT,
  status_hint     TEXT,
  summary         TEXT         NOT NULL,
  payload         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT         NOT NULL DEFAULT 'ACTIVE',
  superseded_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT document_operation_candidates_confidence_chk CHECK (confidence IN ('certain', 'probable', 'conflictual')),
  CONSTRAINT document_operation_candidates_type_hint_chk CHECK (type_hint IS NULL OR type_hint IN ('ACQUISITION', 'INTERVENTION', 'CONTRACT', 'FINANCING', 'CLAIM', 'DISPOSAL', 'OTHER')),
  CONSTRAINT document_operation_candidates_status_hint_chk CHECK (status_hint IS NULL OR status_hint IN ('ENVISAGED', 'REALIZED', 'CANCELLED')),
  CONSTRAINT document_operation_candidates_status_chk CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
  CONSTRAINT document_operation_candidates_payload_chk CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT document_operation_candidates_lifecycle_chk CHECK ((status = 'ACTIVE') = (superseded_at IS NULL))
);

-- Clé locale unique dans l'extraction (C3.2).
CREATE UNIQUE INDEX IF NOT EXISTS document_operation_candidates_key_uidx
  ON document_operation_candidates (extraction_id, candidate_key);

-- ── Mémoire des décisions de rapprochement (C6.3) ──────────────────────────
CREATE TABLE IF NOT EXISTS business_operation_match_decisions (
  id                     BIGSERIAL    PRIMARY KEY,
  account_id             INTEGER      NOT NULL,
  source_kind            TEXT         NOT NULL,
  source_entity_key      TEXT         NOT NULL,
  source_version         TEXT,
  candidate_operation_id BIGINT       NOT NULL,
  decision               TEXT         NOT NULL,
  origin                 TEXT         NOT NULL,
  reason_code            TEXT         NOT NULL,
  active                 BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_match_decisions_operation_fk FOREIGN KEY (candidate_operation_id, account_id) REFERENCES business_operations(id, account_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT business_operation_match_decisions_kind_chk CHECK (source_kind IN ('DOCUMENT', 'ASSET_DATA', 'EQUIPMENT_DATA', 'AGENDA', 'CLAIM_FORM', 'USER_ARBITRATION', 'MIGRATION')),
  CONSTRAINT business_operation_match_decisions_decision_chk CHECK (decision IN ('CONFIRMED', 'REJECTED')),
  CONSTRAINT business_operation_match_decisions_origin_chk CHECK (origin IN ('USER_ARBITRATION', 'SYSTEM_EXPLICIT_REFERENCE'))
);

-- Une décision ACTIVE par (Opération, source, version).
CREATE UNIQUE INDEX IF NOT EXISTS business_operation_match_decisions_active_uidx
  ON business_operation_match_decisions (candidate_operation_id, source_kind, source_entity_key, COALESCE(source_version, ''))
  WHERE active;

-- ── CONTRACT (C13) ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_operation_contract_details (
  operation_id       BIGINT       PRIMARY KEY REFERENCES business_operations(id) ON DELETE CASCADE,
  contract_reference TEXT,
  periodicity        TEXT,
  effective_from     DATE,
  effective_to       DATE,
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_contract_details_periodicity_chk CHECK (periodicity IS NULL OR periodicity IN ('MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'MULTIANNUAL', 'ONE_OFF', 'OTHER'))
);

-- ── FINANCING (C13) : principal hors TCO ───────────────────────────────────
CREATE TABLE IF NOT EXISTS business_operation_financing_details (
  operation_id           BIGINT       PRIMARY KEY REFERENCES business_operations(id) ON DELETE CASCADE,
  financing_reference    TEXT,
  lender                 TEXT,
  principal_amount_minor BIGINT,
  principal_currency     CHAR(3),
  effective_from         DATE,
  effective_to           DATE,
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_financing_details_principal_chk CHECK (principal_amount_minor IS NULL OR principal_amount_minor >= 0),
  CONSTRAINT business_operation_financing_details_currency_chk CHECK (principal_currency IS NULL OR principal_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT business_operation_financing_details_principal_currency_chk CHECK (principal_amount_minor IS NULL OR principal_currency IS NOT NULL)
);

-- ── CLAIM (C14) : statut dossier distinct du statut Opération (C14.1) ──────
CREATE TABLE IF NOT EXISTS business_operation_claim_details (
  operation_id                    BIGINT       PRIMARY KEY REFERENCES business_operations(id) ON DELETE CASCADE,
  claim_type                      TEXT,
  declared_on                     DATE,
  insurer_claim_ref               TEXT,
  insurance_contract_operation_id BIGINT       REFERENCES business_operations(id) ON DELETE SET NULL,
  policy_reference_text           TEXT,
  status                          TEXT,
  status_detail                   TEXT,
  circumstances                   TEXT,
  consequences                    TEXT,
  measures_summary                TEXT,
  exchanges_summary               TEXT,
  estimated_damage_minor          BIGINT,
  updated_at                      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_claim_details_status_chk CHECK (status IS NULL OR status IN ('A_DECLARER', 'DECLARE', 'EXPERTISE_PREVUE', 'EXPERTISE_REALISEE', 'EN_ATTENTE_INDEMNISATION', 'INDEMNISE', 'REFUSE', 'CLOS')),
  CONSTRAINT business_operation_claim_details_estimate_chk CHECK (estimated_damage_minor IS NULL OR estimated_damage_minor >= 0),
  CONSTRAINT business_operation_claim_details_contract_chk CHECK (insurance_contract_operation_id IS NULL OR insurance_contract_operation_id <> operation_id)
);

-- Un dommage n'est pas une Opération (C14).
CREATE TABLE IF NOT EXISTS business_operation_claim_damages (
  id                     BIGSERIAL    PRIMARY KEY,
  operation_id           BIGINT       NOT NULL REFERENCES business_operations(id) ON DELETE CASCADE,
  zone                   TEXT         NOT NULL,
  element                TEXT,
  finding                TEXT,
  estimated_amount_minor BIGINT,
  sort_order             INTEGER      NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_claim_damages_estimate_chk CHECK (estimated_amount_minor IS NULL OR estimated_amount_minor >= 0)
);

CREATE TABLE IF NOT EXISTS business_operation_claim_damage_documents (
  damage_id  BIGINT       NOT NULL REFERENCES business_operation_claim_damages(id) ON DELETE CASCADE,
  file_id    INTEGER      NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_claim_damage_documents_pk PRIMARY KEY (damage_id, file_id)
);

CREATE TABLE IF NOT EXISTS business_operation_claim_damage_photos (
  damage_id  BIGINT       NOT NULL REFERENCES business_operation_claim_damages(id) ON DELETE CASCADE,
  photo_id   INTEGER      NOT NULL REFERENCES asset_photos(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_claim_damage_photos_pk PRIMARY KEY (damage_id, photo_id)
);

-- Une action reste une action du sinistre ; INTERVENTION enfant seulement si
-- elle a sa propre réalité métier (C14.2).
CREATE TABLE IF NOT EXISTS business_operation_claim_actions (
  id                 BIGSERIAL    PRIMARY KEY,
  operation_id       BIGINT       NOT NULL REFERENCES business_operations(id) ON DELETE CASCADE,
  date               DATE,
  end_date           DATE,
  status             TEXT,
  title              TEXT         NOT NULL,
  detail             TEXT,
  performed_by       TEXT,
  invoice_file_id    INTEGER      REFERENCES asset_files(id) ON DELETE SET NULL,
  child_operation_id BIGINT       REFERENCES business_operations(id) ON DELETE SET NULL,
  sort_order         INTEGER      NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_claim_actions_status_chk CHECK (status IS NULL OR status IN ('REALISEE', 'EN_COURS', 'A_REALISER')),
  CONSTRAINT business_operation_claim_actions_period_chk CHECK (date IS NULL OR end_date IS NULL OR end_date >= date),
  CONSTRAINT business_operation_claim_actions_child_chk CHECK (child_operation_id IS NULL OR child_operation_id <> operation_id)
);

-- Un échange n'est pas une Opération (C14).
CREATE TABLE IF NOT EXISTS business_operation_claim_exchanges (
  id               BIGSERIAL    PRIMARY KEY,
  operation_id     BIGINT       NOT NULL REFERENCES business_operations(id) ON DELETE CASCADE,
  date             DATE,
  party            TEXT,
  channel          TEXT,
  direction        TEXT,
  summary          TEXT         NOT NULL,
  document_file_id INTEGER      REFERENCES asset_files(id) ON DELETE SET NULL,
  sort_order       INTEGER      NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_claim_exchanges_party_chk CHECK (party IS NULL OR party IN ('ASSUREUR', 'EXPERT', 'AUTRE')),
  CONSTRAINT business_operation_claim_exchanges_channel_chk CHECK (channel IS NULL OR channel IN ('EMAIL', 'COURRIER', 'TELEPHONE', 'ESPACE_CLIENT', 'RENDEZ_VOUS', 'AUTRE')),
  CONSTRAINT business_operation_claim_exchanges_direction_chk CHECK (direction IS NULL OR direction IN ('RECU', 'ENVOYE'))
);
