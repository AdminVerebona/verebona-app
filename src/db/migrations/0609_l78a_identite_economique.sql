-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0609 : Opérations — identité économique, provenance et correction
-- rétroactive tracée (lot 78A — ticket « [P1] Opérations & TCO — Fiabiliser
-- l'identité économique, les rapprochements, les données financières et leur
-- provenance », §2, §4, §5, §6).
--
--   business_operation_financial_component_sources.evidence (JSONB, nul
--     permis) — lien EXACT composante → indice T1 → fait persisté :
--     { candidateId, hintIndexes[], factIds[] } (manquait : signalé par le
--     diagnostic 77C « Lien composante → indice T1 : non persisté par T3 »).
--     Écrit par la reconsolidation T3 (sans historique : trace technique).
--
--   business_operations.attribute_provenance (JSONB, nul permis) — origine
--     des valeurs conservées (dates, prestataire, libellé : source et valeur)
--     et contradictions d'attributs entre sources (jamais tranchées en
--     silence). Sert aussi la réévaluation d'une valeur dont la source est
--     retirée (une valeur corrigée par l'utilisateur n'est jamais touchée).
--
--   business_operation_identity_reviews — journal des contrôles d'identité
--     économique des rattachements HISTORIQUES et de leur traitement :
--     SEPARATED (source contredite retirée de l'Opération, automatique
--     seulement si certain), SUSPECT (conservée, signalée pour examen au BO),
--     DUPLICATE_RELOCATED (doublon d'un même document rejoint l'Opération la
--     plus ancienne — l'autre est invalidée, jamais fusionnée). Statuts :
--     APPLIED, OPEN, RESOLVED, REVERTED (rétablissement BO tracé).
--
--   business_operation_match_decisions.origin : + ADMIN_REVIEW (décision de
--     rétablissement d'un rattachement séparé, prise au BO et journalisée).
--
-- Colonnes nullables sans défaut volatil, table neuve : aucune réécriture.
-- Index dans 0609_..._idx_N (CONCURRENTLY). Idempotente.
-- Retour arrière : DROP TABLE IF EXISTS business_operation_identity_reviews ;
-- les deux colonnes peuvent rester (ignorées par une version antérieure).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE business_operation_financial_component_sources ADD COLUMN IF NOT EXISTS evidence JSONB;
ALTER TABLE business_operations ADD COLUMN IF NOT EXISTS attribute_provenance JSONB;

CREATE TABLE IF NOT EXISTS business_operation_identity_reviews (
  id                   BIGSERIAL   PRIMARY KEY,
  account_id           INTEGER     NOT NULL,
  operation_id         BIGINT      NOT NULL,
  kind                 TEXT        NOT NULL,
  status               TEXT        NOT NULL,
  file_id              INTEGER     REFERENCES asset_files(id) ON DELETE SET NULL,
  candidate_key        TEXT,
  source_id            BIGINT      REFERENCES business_operation_sources(id) ON DELETE SET NULL,
  target_operation_id  BIGINT,
  basis                TEXT,
  signals              JSONB       NOT NULL DEFAULT '[]'::jsonb,
  against_source_ids   BIGINT[]    NOT NULL DEFAULT '{}',
  review_version       TEXT        NOT NULL,
  correlation_id       TEXT,
  resolved_by_admin_id INTEGER,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at          TIMESTAMPTZ,
  CONSTRAINT business_operation_identity_reviews_operation_fk FOREIGN KEY (operation_id, account_id)
    REFERENCES business_operations(id, account_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT business_operation_identity_reviews_kind_chk CHECK (kind IN ('SEPARATED', 'SUSPECT', 'DUPLICATE_RELOCATED')),
  CONSTRAINT business_operation_identity_reviews_status_chk CHECK (status IN ('APPLIED', 'OPEN', 'RESOLVED', 'REVERTED')),
  CONSTRAINT business_operation_identity_reviews_signals_chk CHECK (jsonb_typeof(signals) = 'array')
);

COMMENT ON TABLE business_operation_identity_reviews IS
  'Lot 78A : contrôles d''identité économique des rattachements historiques des Opérations (séparation certaine, doute signalé, doublon d''un même document) et leur traitement — journal, jamais une donnée métier.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'business_operation_match_decisions'::regclass
              AND conname = 'business_operation_match_decisions_origin_chk' AND pg_get_constraintdef(oid) NOT LIKE '%ADMIN_REVIEW%') THEN
    ALTER TABLE business_operation_match_decisions DROP CONSTRAINT business_operation_match_decisions_origin_chk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'business_operation_match_decisions'::regclass
                  AND conname = 'business_operation_match_decisions_origin_chk') THEN
    ALTER TABLE business_operation_match_decisions ADD CONSTRAINT business_operation_match_decisions_origin_chk
      CHECK (origin IN ('USER_ARBITRATION', 'SYSTEM_EXPLICIT_REFERENCE', 'ADMIN_REVIEW'));
  END IF;
END $$;
