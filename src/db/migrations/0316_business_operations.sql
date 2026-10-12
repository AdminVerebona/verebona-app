-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0316 : socle des Opérations métier (lot 39, O1 — CDC Opérations V1
-- C20, C20.1, C27, B20-B21, ch. 10 et 22).
--
-- Une Opération (`business_operations`) est une réalité métier consolidée,
-- distincte de ses preuves (`business_operation_sources`). Elle est TECHNIQUE
-- et invisible pour l'utilisateur (P09) ; seul T3 la consolidera (lots
-- suivants). Ce lot ne crée aucune Opération : tables, contraintes, référentiel.
-- `ai_operations` (opérations techniques IA) n'est jamais réutilisée (F-198).
--
-- ISOLATION PAR COMPTE (ch. 22, C25, F-169/F-170) : chaque table fille porte
-- `account_id` et référence l'Opération par la clé COMPOSÉE (id, account_id)
-- — un lien vers l'Opération d'un autre compte est impossible en SQL. La même
-- clé est mise à jour en cascade (ON UPDATE CASCADE) : le transfert d'un bien
-- entre comptes (décision PO Q14) déplace l'Opération et toutes ses lignes en
-- une seule instruction. Le parent et la redirection de fusion utilisent aussi
-- la clé composée (même compte obligatoire), SANS cascade : une suppression
-- physique isolée d'un parent est refusée (F-077) ; seule la suppression du
-- compte emporte tout.
--
-- Montants : entiers ≥ 0 en unités mineures ; le signe économique est porté
-- par `kind` (C12). Devise ISO 4217 conservée (C12.3).
--
-- ÉCART DOCUMENTÉ — `business_operation_references` : C20 ne prévoit pas de
-- table des références métier (numéro de facture, de contrat, de dossier, de
-- commande…). Elle est ajoutée pour le rapprochement M1 sur référence exacte
-- (C6.1, C7), indexée par compte / nature / valeur normalisée.
--
-- Idempotente (IF NOT EXISTS, ON CONFLICT) ; expand seulement. Index non
-- uniques : fichiers `0316_business_operations_idx_N` (CONCURRENTLY).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

-- ── Référentiel des 7 types (C27) : contrôlé par le code, aucun 8e type ─────
CREATE TABLE IF NOT EXISTS business_operation_types (
  code                      TEXT         PRIMARY KEY,
  label                     TEXT         NOT NULL,
  description               TEXT         NOT NULL,
  applicable_asset_families JSONB        NOT NULL DEFAULT '[]'::jsonb,
  active                    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_types_code_chk CHECK (code IN ('ACQUISITION', 'INTERVENTION', 'CONTRACT', 'FINANCING', 'CLAIM', 'DISPOSAL', 'OTHER')),
  CONSTRAINT business_operation_types_families_chk CHECK (jsonb_typeof(applicable_asset_families) = 'array')
);

-- `applicable_asset_families` vide = toutes les familles (C27).
INSERT INTO business_operation_types (code, label, description, applicable_asset_families, active) VALUES
  ('ACQUISITION', 'Acquisition / entrée en possession', 'Achat, don reçu, succession, transfert de propriété vers le compte, levée d''option lorsque l''utilisateur devient propriétaire.', '[]'::jsonb, TRUE),
  ('INTERVENTION', 'Intervention', 'Entretien, réparation, travaux, installation, remplacement, rénovation, contrôle, diagnostic réalisé comme prestation, expertise, inspection.', '[]'::jsonb, TRUE),
  ('CONTRACT', 'Contrat', 'Assurance, abonnement, contrat de maintenance, assistance, location, LLD, LOA, service récurrent.', '[]'::jsonb, TRUE),
  ('FINANCING', 'Financement', 'Crédit, prêt ou financement associé à une acquisition.', '[]'::jsonb, TRUE),
  ('CLAIM', 'Sinistre', 'Accident, dégât, vol, incendie, casse ou événement dommageable, assuré ou non.', '[]'::jsonb, TRUE),
  ('DISPOSAL', 'Cession / sortie de possession', 'Vente, don, transmission, reprise, mise au rebut ou autre sortie définitive et établie.', '[]'::jsonb, TRUE),
  ('OTHER', 'Autre', 'Véritable opération métier qui ne relève d''aucun autre type après qualification. Jamais une valeur de repli : l''incertitude se note type nul.', '[]'::jsonb, TRUE)
ON CONFLICT (code) DO NOTHING;

-- ── Opérations (C20) ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_operations (
  id                       BIGSERIAL    PRIMARY KEY,
  account_id               INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type_code                TEXT         REFERENCES business_operation_types(code),
  status                   TEXT         NOT NULL,
  technical_label          TEXT,
  parent_operation_id      BIGINT,
  provider                 TEXT,
  planned_date             DATE,
  start_date               DATE,
  realized_date            DATE,
  end_date                 DATE,
  closed_at                TIMESTAMPTZ,
  invalidated_at           TIMESTAMPTZ,
  invalidation_reason      TEXT,
  merged_into_operation_id BIGINT,
  last_reconciled_at       TIMESTAMPTZ,
  version                  INTEGER      NOT NULL DEFAULT 1,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operations_id_account_uq UNIQUE (id, account_id),
  CONSTRAINT business_operations_parent_fk FOREIGN KEY (parent_operation_id, account_id) REFERENCES business_operations(id, account_id),
  CONSTRAINT business_operations_merged_into_fk FOREIGN KEY (merged_into_operation_id, account_id) REFERENCES business_operations(id, account_id),
  CONSTRAINT business_operations_status_chk CHECK (status IN ('ENVISAGED', 'REALIZED', 'CANCELLED')),
  CONSTRAINT business_operations_parent_not_self_chk CHECK (parent_operation_id IS NULL OR parent_operation_id <> id),
  CONSTRAINT business_operations_merged_not_self_chk CHECK (merged_into_operation_id IS NULL OR merged_into_operation_id <> id),
  CONSTRAINT business_operations_merged_invalidated_chk CHECK (merged_into_operation_id IS NULL OR invalidated_at IS NOT NULL),
  CONSTRAINT business_operations_invalidation_reason_chk CHECK (invalidated_at IS NULL OR invalidation_reason IS NOT NULL),
  CONSTRAINT business_operations_version_chk CHECK (version >= 1)
);

-- ── Sources / provenance (C2, C20) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_operation_sources (
  id                BIGSERIAL    PRIMARY KEY,
  account_id        INTEGER      NOT NULL,
  operation_id      BIGINT       NOT NULL,
  source_kind       TEXT         NOT NULL,
  source_entity_key TEXT         NOT NULL,
  source_version    TEXT,
  source_role       TEXT,
  locator           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  authority         TEXT         NOT NULL,
  confidence        TEXT,
  match_method      TEXT,
  match_reason      TEXT,
  active            BOOLEAN      NOT NULL DEFAULT TRUE,
  superseded_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_sources_operation_fk FOREIGN KEY (operation_id, account_id) REFERENCES business_operations(id, account_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT business_operation_sources_kind_chk CHECK (source_kind IN ('DOCUMENT', 'ASSET_DATA', 'EQUIPMENT_DATA', 'AGENDA', 'CLAIM_FORM', 'USER_ARBITRATION', 'MIGRATION')),
  CONSTRAINT business_operation_sources_entity_key_chk CHECK (source_entity_key <> ''),
  CONSTRAINT business_operation_sources_role_chk CHECK (source_role IS NULL OR source_role IN ('QUOTE', 'ORDER', 'INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE', 'REFUND_PROOF', 'PAYMENT_PROOF', 'CONTRACT_DOCUMENT', 'CLAIM_DOCUMENT', 'SALE_DOCUMENT', 'REPORT', 'OTHER_EVIDENCE')),
  CONSTRAINT business_operation_sources_locator_chk CHECK (jsonb_typeof(locator) = 'object'),
  CONSTRAINT business_operation_sources_authority_chk CHECK (authority IN ('USER', 'DOCUMENT', 'STRUCTURED', 'INFERENCE')),
  CONSTRAINT business_operation_sources_confidence_chk CHECK (confidence IS NULL OR confidence IN ('certain', 'probable', 'conflictual')),
  CONSTRAINT business_operation_sources_match_method_chk CHECK (match_method IS NULL OR match_method IN ('M0', 'M1', 'M2', 'M3')),
  CONSTRAINT business_operation_sources_lifecycle_chk CHECK (active = (superseded_at IS NULL))
);

-- Unique logique d'une source ACTIVE vers une même Opération, même locator et
-- même rôle (C20.1, B21).
CREATE UNIQUE INDEX IF NOT EXISTS business_operation_sources_active_uidx
  ON business_operation_sources (operation_id, source_kind, source_entity_key, COALESCE(source_role, ''), md5(locator::text))
  WHERE active;

-- ── Liens biens (C10, C20) : PRIMARY / CONCERNED, sans ventilation ─────────
CREATE TABLE IF NOT EXISTS business_operation_asset_links (
  id                         BIGSERIAL    PRIMARY KEY,
  account_id                 INTEGER      NOT NULL,
  operation_id               BIGINT       NOT NULL,
  asset_id                   INTEGER      NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  link_role                  TEXT         NOT NULL DEFAULT 'CONCERNED',
  authority                  TEXT         NOT NULL,
  source_operation_source_id BIGINT       REFERENCES business_operation_sources(id) ON DELETE SET NULL,
  active                     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_asset_links_operation_fk FOREIGN KEY (operation_id, account_id) REFERENCES business_operations(id, account_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT business_operation_asset_links_role_chk CHECK (link_role IN ('PRIMARY', 'CONCERNED')),
  CONSTRAINT business_operation_asset_links_authority_chk CHECK (authority IN ('USER', 'DOCUMENT', 'STRUCTURED', 'INFERENCE'))
);

-- Une ligne par couple (Opération, bien), réactivée plutôt que dupliquée.
CREATE UNIQUE INDEX IF NOT EXISTS business_operation_asset_links_pair_uidx
  ON business_operation_asset_links (operation_id, asset_id);
-- Au plus un bien PRIMARY actif par Opération.
CREATE UNIQUE INDEX IF NOT EXISTS business_operation_asset_links_primary_uidx
  ON business_operation_asset_links (operation_id)
  WHERE active AND link_role = 'PRIMARY';

-- ── Liens équipements (C10.1, C20) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_operation_equipment_links (
  id                         BIGSERIAL    PRIMARY KEY,
  account_id                 INTEGER      NOT NULL,
  operation_id               BIGINT       NOT NULL,
  equipment_id               INTEGER      NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
  asset_id                   INTEGER      NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  authority                  TEXT         NOT NULL,
  source_operation_source_id BIGINT       REFERENCES business_operation_sources(id) ON DELETE SET NULL,
  active                     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_equipment_links_operation_fk FOREIGN KEY (operation_id, account_id) REFERENCES business_operations(id, account_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT business_operation_equipment_links_authority_chk CHECK (authority IN ('USER', 'DOCUMENT', 'STRUCTURED', 'INFERENCE'))
);

CREATE UNIQUE INDEX IF NOT EXISTS business_operation_equipment_links_pair_uidx
  ON business_operation_equipment_links (operation_id, equipment_id);

-- ── Composantes financières (C12, C20) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_operation_financial_components (
  id                  BIGSERIAL    PRIMARY KEY,
  account_id          INTEGER      NOT NULL,
  operation_id        BIGINT       NOT NULL,
  kind                TEXT         NOT NULL,
  amount_minor        BIGINT       NOT NULL,
  currency            CHAR(3)      NOT NULL,
  amount_eur_cents    BIGINT,
  economic_date       DATE,
  period_start        DATE,
  period_end          DATE,
  target_asset_id     INTEGER      REFERENCES assets(id) ON DELETE SET NULL,
  target_equipment_id INTEGER      REFERENCES equipments(id) ON DELETE SET NULL,
  label               TEXT,
  fingerprint         TEXT,
  active              BOOLEAN      NOT NULL DEFAULT TRUE,
  superseded_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_financial_components_operation_fk FOREIGN KEY (operation_id, account_id) REFERENCES business_operations(id, account_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT business_operation_financial_components_kind_chk CHECK (kind IN ('FORECAST_COST', 'REALIZED_COST', 'REDUCTION', 'REFUND', 'INDEMNITY', 'PROCEED')),
  CONSTRAINT business_operation_financial_components_amount_chk CHECK (amount_minor >= 0),
  CONSTRAINT business_operation_financial_components_eur_chk CHECK (amount_eur_cents IS NULL OR amount_eur_cents >= 0),
  CONSTRAINT business_operation_financial_components_currency_chk CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT business_operation_financial_components_period_chk CHECK (period_start IS NULL OR period_end IS NULL OR period_end >= period_start),
  CONSTRAINT business_operation_financial_components_lifecycle_chk CHECK (active = (superseded_at IS NULL))
);

-- Un même fait économique actif n'est jamais dupliqué (C12.1).
CREATE UNIQUE INDEX IF NOT EXISTS business_operation_financial_components_fingerprint_uidx
  ON business_operation_financial_components (operation_id, fingerprint)
  WHERE active AND fingerprint IS NOT NULL;

-- ── Sources des composantes (10.6, C20) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_operation_financial_component_sources (
  component_id        BIGINT       NOT NULL REFERENCES business_operation_financial_components(id) ON DELETE CASCADE,
  operation_source_id BIGINT       NOT NULL REFERENCES business_operation_sources(id) ON DELETE CASCADE,
  evidence_role       TEXT         NOT NULL DEFAULT 'SUPPORTS',
  is_primary          BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_financial_component_sources_pk PRIMARY KEY (component_id, operation_source_id),
  CONSTRAINT business_operation_financial_component_sources_role_chk CHECK (evidence_role IN ('SUPPORTS', 'CORRECTS', 'SUPERSEDES'))
);

-- ── Historique des changements significatifs (10.7, C20) ───────────────────
-- SOURCE_ADDED / SOURCE_REMOVED : B20 (C20 ne les nomme pas mais 10.7 exige
-- d'historiser la source de référence).
CREATE TABLE IF NOT EXISTS business_operation_history (
  id             BIGSERIAL    PRIMARY KEY,
  account_id     INTEGER      NOT NULL,
  operation_id   BIGINT       NOT NULL,
  event_type     TEXT         NOT NULL,
  reason_code    TEXT         NOT NULL,
  source_id      BIGINT       REFERENCES business_operation_sources(id) ON DELETE SET NULL,
  actor_user_id  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  before_json    JSONB,
  after_json     JSONB,
  correlation_id TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_history_operation_fk FOREIGN KEY (operation_id, account_id) REFERENCES business_operations(id, account_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT business_operation_history_event_type_chk CHECK (event_type IN ('CREATED', 'UPDATED', 'TYPE_CHANGED', 'STATUS_CHANGED', 'TARGET_CHANGED', 'FINANCIAL_CHANGED', 'MERGED', 'INVALIDATED', 'REACTIVATED', 'PARENT_CHANGED', 'SOURCE_ADDED', 'SOURCE_REMOVED'))
);

-- ── Suppressions durables de projection (C16.1) ────────────────────────────
CREATE TABLE IF NOT EXISTS business_operation_projection_suppressions (
  id              BIGSERIAL    PRIMARY KEY,
  account_id      INTEGER      NOT NULL,
  operation_id    BIGINT       NOT NULL,
  projection_kind TEXT         NOT NULL,
  projection_key  TEXT         NOT NULL,
  user_id         INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_projection_suppressions_operation_fk FOREIGN KEY (operation_id, account_id) REFERENCES business_operations(id, account_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT business_operation_projection_suppressions_uq UNIQUE (operation_id, projection_kind, projection_key),
  CONSTRAINT business_operation_projection_suppressions_kind_chk CHECK (projection_kind IN ('AGENDA'))
);

-- ── Références métier (écart C20 documenté en tête) ────────────────────────
CREATE TABLE IF NOT EXISTS business_operation_references (
  id               BIGSERIAL    PRIMARY KEY,
  account_id       INTEGER      NOT NULL,
  operation_id     BIGINT       NOT NULL,
  reference_kind   TEXT         NOT NULL,
  reference_value  TEXT         NOT NULL,
  normalized_value TEXT         NOT NULL,
  source_id        BIGINT       REFERENCES business_operation_sources(id) ON DELETE SET NULL,
  active           BOOLEAN      NOT NULL DEFAULT TRUE,
  superseded_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_references_operation_fk FOREIGN KEY (operation_id, account_id) REFERENCES business_operations(id, account_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT business_operation_references_kind_chk CHECK (reference_kind IN ('INVOICE', 'QUOTE', 'ORDER', 'WORK_ORDER', 'CONTRACT', 'POLICY', 'CLAIM', 'LOAN', 'CUSTOMER', 'DELIVERY', 'OTHER')),
  CONSTRAINT business_operation_references_value_chk CHECK (normalized_value <> ''),
  CONSTRAINT business_operation_references_lifecycle_chk CHECK (active = (superseded_at IS NULL))
);

-- Une ligne par (Opération, nature, valeur normalisée), réactivée plutôt que dupliquée.
CREATE UNIQUE INDEX IF NOT EXISTS business_operation_references_value_uidx
  ON business_operation_references (operation_id, reference_kind, normalized_value);
