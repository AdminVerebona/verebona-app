-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1560 : PÉRIODES MÉTIER d'un document (lot 113W, carte Trello #724
-- « Gestion transversale des périodes métier — Documents, Opérations,
-- Contrats et Dépenses »).
--
-- Une ligne = UN fait de période qualifié d'un document : nature (couverture,
-- facturation, validité, garantie, prestation), bornes PARTIELLES (AAAA,
-- AAAA-MM ou AAAA-MM-JJ, chacune facultative : une période pertinente sans
-- date est une ligne aux deux bornes nulles = « non renseignée »), segment
-- (périodes discontinues d'un même document), indice de période principale,
-- provenance (T1 / T3 / USER), fondement et preuves (citation, page, faits,
-- candidat), correction de l'utilisateur PROTÉGÉE des retraitements
-- automatiques (`user_locked`), état avant correction.
--
-- Pourquoi une table : aucune donnée existante ne porte la NATURE d'une
-- période, ses bornes partielles ni une correction protégée —
--   · `document_facts.period_start / period_end` et les indices des candidats
--     T1 (`document_operation_candidates.payload`) sont des EXTRACTIONS brutes,
--     remplacées à chaque analyse (une correction y serait perdue) ;
--   · `document.billingPeriod` (t1-billing-period-v1) ne vit que dans la sortie
--     brute du run T1 ;
--   · `business_operation_contract_details.effective_from / effective_to` sont
--     les dates CONTRACTUELLES de la relation (lot 86C), jamais une couverture
--     ni une période facturée ; elles ne sont PAS dupliquées ici.
-- Les faits de cette table sont DÉRIVÉS de façon déterministe des extractions
-- persistées (service `documents/business-periods`), rejouables et
-- idempotents ; l'historique de couverture d'un événement de référence est
-- LU à travers l'appartenance des documents (`business_operation_documents`) :
-- aucun second historique, aucune écriture `business_operation_*`.
--
-- Additive, idempotente, rejouable. Suppression du compte / du document :
-- cascade. Retour arrière : DROP TABLE (le code ignore son absence).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_business_periods (
  id                    BIGSERIAL    PRIMARY KEY,
  account_id            INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id               INTEGER      NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  period_kind           TEXT         NOT NULL,
  segment_index         SMALLINT     NOT NULL DEFAULT 0,
  start_on              TEXT,
  end_on                TEXT,
  principal_hint        BOOLEAN      NOT NULL DEFAULT FALSE,
  origin                TEXT         NOT NULL,
  basis                 TEXT         NOT NULL,
  evidence              JSONB        NOT NULL DEFAULT '{}'::jsonb,
  user_locked           BOOLEAN      NOT NULL DEFAULT FALSE,
  corrected_by_user_id  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  corrected_at          TIMESTAMPTZ,
  before_correction     JSONB,
  status                TEXT         NOT NULL DEFAULT 'ACTIVE',
  superseded_at         TIMESTAMPTZ,
  correlation_id        TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_business_periods_kind_chk') THEN
    ALTER TABLE document_business_periods ADD CONSTRAINT document_business_periods_kind_chk
      CHECK (period_kind IN ('COVERAGE', 'BILLING', 'VALIDITY', 'WARRANTY', 'SERVICE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_business_periods_segment_chk') THEN
    ALTER TABLE document_business_periods ADD CONSTRAINT document_business_periods_segment_chk
      CHECK (segment_index >= 0 AND segment_index < 50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_business_periods_start_chk') THEN
    ALTER TABLE document_business_periods ADD CONSTRAINT document_business_periods_start_chk
      CHECK (start_on IS NULL OR start_on ~ '^[0-9]{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?)?$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_business_periods_end_chk') THEN
    ALTER TABLE document_business_periods ADD CONSTRAINT document_business_periods_end_chk
      CHECK (end_on IS NULL OR end_on ~ '^[0-9]{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?)?$');
  END IF;
  -- Bornes ordonnées : plus petite date possible du début ≤ plus grande date possible de la fin.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_business_periods_order_chk') THEN
    ALTER TABLE document_business_periods ADD CONSTRAINT document_business_periods_order_chk
      CHECK (start_on IS NULL OR end_on IS NULL OR
        (CASE length(start_on) WHEN 4 THEN start_on || '-01-01' WHEN 7 THEN start_on || '-01' ELSE start_on END)
        <= (CASE length(end_on) WHEN 4 THEN end_on || '-12-31' WHEN 7 THEN end_on || '-31' ELSE end_on END));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_business_periods_origin_chk') THEN
    ALTER TABLE document_business_periods ADD CONSTRAINT document_business_periods_origin_chk
      CHECK (origin IN ('T1', 'T3', 'USER'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_business_periods_status_chk') THEN
    ALTER TABLE document_business_periods ADD CONSTRAINT document_business_periods_status_chk
      CHECK (status IN ('ACTIVE', 'SUPERSEDED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_business_periods_lifecycle_chk') THEN
    ALTER TABLE document_business_periods ADD CONSTRAINT document_business_periods_lifecycle_chk
      CHECK ((status = 'ACTIVE') = (superseded_at IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_business_periods_evidence_chk') THEN
    ALTER TABLE document_business_periods ADD CONSTRAINT document_business_periods_evidence_chk
      CHECK (jsonb_typeof(evidence) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_business_periods_user_chk') THEN
    ALTER TABLE document_business_periods ADD CONSTRAINT document_business_periods_user_chk
      CHECK (NOT user_locked OR origin = 'USER');
  END IF;
END $$;

-- Un seul fait ACTIF par (document, nature, segment).
CREATE UNIQUE INDEX IF NOT EXISTS document_business_periods_active_uidx
  ON document_business_periods (file_id, period_kind, segment_index) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS document_business_periods_account_idx
  ON document_business_periods (account_id, file_id) WHERE status = 'ACTIVE';
