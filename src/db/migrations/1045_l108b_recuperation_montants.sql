-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1045 : récupération automatique des montants inconnus des
-- justificatifs de dépense AVANT toute alerte du TCO (lot 108B, ticket
-- TCO-646 §B « Des justificatifs de dépense n’ont pas de montant lisible… »).
--
--   document_amount_recoveries  — UNE ligne par document (justificatif financier
--       dont le moteur TCO ne connaît pas le montant) : état de la récupération
--       et PROVENANCE du montant retrouvé.
--
--   status            PENDING       examiné, recherche ou relance prévue ;
--                     T1_PENDING    relecture T1 du document original demandée
--                                   (file T1 existante, traitement technique) ;
--                     RECOVERED     montant retrouvé et posé sur le document
--                                   (`asset_files.amount_cents`), provenance
--                                   ci-dessous ;
--                     TO_CONFIRM    montants contradictoires ou incertains après
--                                   les recherches : « Montant à confirmer » ;
--                     NOT_FOUND     aucun montant après relecture : « Montant
--                                   introuvable » ;
--                     TECHNICAL_FAILURE  relecture en échec technique
--                                   (Supervision BO, jamais une carte « À
--                                   traiter ») ;
--                     USER_OWNED    montant retiré / saisi par l'utilisateur :
--                                   jamais remplacé.
--   amount_cents, currency, amount_role (TOTAL_TTC, DOCUMENT_TOTAL, DEPOSIT,
--       BALANCE, CREDIT_NOTE…), source_kind (T1_EXTRACTION, T1_METADATA_UNIT,
--       T1_CANDIDATE, OPERATION_COMPONENT, SOURCE_TEXT_TOTAL, T1_RELAUNCH),
--       source_ref (unité, extraction, candidat, composante) : PREUVE et
--       provenance du montant retrouvé ;
--   previous_amount_cents : valeur avant écriture (retour arrière) ;
--   proposals         montants candidats non retenus (contradiction, rôle
--                     incertain) — jamais écrits ;
--   fingerprint       empreinte (fichier source, configuration T1 effective,
--                     version des règles) de la DERNIÈRE relance T1 ;
--   fingerprint_attempts / total_attempts : relances T1 sur cette empreinte /
--                     au total (bornées : anti-boucle) ; une nouvelle
--                     empreinte (source, modèle ou traitement changé) rouvre
--                     UNE tentative ;
--   technical_failures, last_error_code : échecs techniques constatés.
--
-- Journal technique : aucune donnée de document au-delà du montant et de
-- références d'unités. Suppression du compte / du fichier : CASCADE.
-- Additive et idempotente, rejouable. Retour arrière : DROP TABLE IF EXISTS
-- document_amount_recoveries (l'ancien code ne la lit pas ; les montants écrits
-- restent sur les documents, `previous_amount_cents` NULL les identifie).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_amount_recoveries (
  id                     BIGSERIAL    PRIMARY KEY,
  account_id             INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id                INTEGER      NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  status                 TEXT         NOT NULL DEFAULT 'PENDING',
  amount_cents           BIGINT,
  currency               TEXT,
  amount_role            TEXT,
  source_kind            TEXT,
  source_ref             TEXT,
  previous_amount_cents  BIGINT,
  proposals              JSONB        NOT NULL DEFAULT '[]'::jsonb,
  fingerprint            TEXT,
  fingerprint_attempts   INTEGER      NOT NULL DEFAULT 0,
  total_attempts         INTEGER      NOT NULL DEFAULT 0,
  technical_failures     INTEGER      NOT NULL DEFAULT 0,
  last_error_code        TEXT,
  last_requested_at      TIMESTAMPTZ,
  resolved_at            TIMESTAMPTZ,
  detail                 JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT document_amount_recoveries_file_uq UNIQUE (file_id),
  CONSTRAINT document_amount_recoveries_status_chk CHECK (status IN ('PENDING', 'T1_PENDING', 'RECOVERED', 'TO_CONFIRM', 'NOT_FOUND', 'TECHNICAL_FAILURE', 'USER_OWNED')),
  CONSTRAINT document_amount_recoveries_counts_chk CHECK (fingerprint_attempts >= 0 AND total_attempts >= 0 AND technical_failures >= 0),
  CONSTRAINT document_amount_recoveries_proposals_chk CHECK (jsonb_typeof(proposals) = 'array')
);

COMMENT ON TABLE document_amount_recoveries IS
  'Lot 108B : récupération automatique du montant des justificatifs de dépense sans montant (état, provenance, tentatives T1 bornées) — avant toute alerte du TCO.';
