-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0798 : décisions de T1 sur les valeurs significatives des unités
-- sources (lot 91D, ticket P1 « Fiabiliser la traçabilité des décisions T1 et
-- la qualification des omissions documentaires » — contrat
-- `t1-value-decisions-v1`, demande IA historique 82B-t1-omissions-extract).
--
-- `document_value_decisions` : une ligne par valeur (montant, date,
-- identifiant) d'une unité source qualifiée par T1 : STRUCTURED (reprise dans
-- un fait), COMPONENT_OR_CONTEXT (composante ou contexte d'un fait / d'un
-- candidat, ex. frais inclus dans un total), NOT_RETAINED (non retenue, avec
-- son motif), UNDETERMINED (interprétation incertaine). Provenance complète :
-- document, extraction et analyse, version du prompt, unité source et
-- empreinte de son texte, preuve citée, faits et candidats rattachés,
-- confiance, validité constatée par le serveur (VALID / INVALID + motif).
--
-- CYCLE DE VIE (jamais de suppression) : une nouvelle analyse T1 du document
-- fait passer les décisions courantes en `SUPERSEDED` (motif, date) dans la
-- même transaction que les faits ; un réexamen ciblé remplace seulement les
-- décisions des valeurs réexaminées. Historique conservé pour l'audit. Une
-- décision active dont l'unité a changé (empreinte différente) n'est plus
-- utilisée par le contrôle. Index unique PARTIEL sur les lignes ACTIVES :
-- aucun doublon (même décision rejouée = même ligne).
--
-- Additive, idempotente, aucune reprise de données. Suit le document lors
-- d'un changement de compte (asset-account-transfer : `file_id`), supprimée
-- avec le compte ou le document (clés étrangères ON DELETE CASCADE).
-- Table neuve : index créés ici (création instantanée).
-- Retour arrière : DROP TABLE IF EXISTS document_value_decisions (le
-- contrôle COH-DOC-EXTRACT-CHAIN revient alors à ses constats d'avant).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_value_decisions (
  id                     BIGSERIAL   PRIMARY KEY,
  account_id             INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id                INTEGER     NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  extraction_id          BIGINT,
  analysis_run_id        BIGINT,
  origin                 TEXT        NOT NULL,
  contract_version       TEXT        NOT NULL,
  prompt_version         TEXT        NOT NULL DEFAULT '',
  source_unit_id         TEXT,
  unit_fingerprint       TEXT,
  value_kind             TEXT,
  raw_value              TEXT        NOT NULL DEFAULT '',
  normalized_value       TEXT,
  decision               TEXT,
  reason                 TEXT        NOT NULL DEFAULT '',
  confidence             TEXT,
  evidence               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  related_fact_ids       BIGINT[]    NOT NULL DEFAULT '{}',
  related_fact_refs      TEXT[]      NOT NULL DEFAULT '{}',
  related_candidate_keys TEXT[]      NOT NULL DEFAULT '{}',
  validity               TEXT        NOT NULL,
  invalid_reason         TEXT,
  status                 TEXT        NOT NULL DEFAULT 'ACTIVE',
  superseded_at          TIMESTAMPTZ,
  superseded_reason      TEXT,
  decision_fp            TEXT        NOT NULL,
  ai_trace_id            TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_value_decisions_origin_chk CHECK (origin IN ('ANALYSIS', 'REVIEW')),
  CONSTRAINT document_value_decisions_kind_chk CHECK (value_kind IS NULL OR value_kind IN ('AMOUNT', 'DATE', 'IDENTIFIER')),
  CONSTRAINT document_value_decisions_decision_chk CHECK (decision IS NULL OR decision IN ('STRUCTURED', 'COMPONENT_OR_CONTEXT', 'NOT_RETAINED', 'UNDETERMINED')),
  CONSTRAINT document_value_decisions_confidence_chk CHECK (confidence IS NULL OR confidence IN ('certain', 'probable', 'conflictual')),
  CONSTRAINT document_value_decisions_validity_chk CHECK (validity IN ('VALID', 'INVALID') AND ((validity = 'VALID') = (invalid_reason IS NULL))),
  CONSTRAINT document_value_decisions_valid_chk CHECK (validity = 'INVALID' OR (source_unit_id IS NOT NULL AND value_kind IS NOT NULL AND normalized_value IS NOT NULL AND decision IS NOT NULL)),
  CONSTRAINT document_value_decisions_status_chk CHECK (status IN ('ACTIVE', 'SUPERSEDED') AND ((status = 'SUPERSEDED') = (superseded_at IS NOT NULL))),
  CONSTRAINT document_value_decisions_evidence_chk CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS document_value_decisions_active_uidx
  ON document_value_decisions (file_id, decision_fp) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS document_value_decisions_file_idx
  ON document_value_decisions (file_id, status, source_unit_id);
CREATE INDEX IF NOT EXISTS document_value_decisions_account_idx
  ON document_value_decisions (account_id, created_at DESC);

COMMENT ON TABLE document_value_decisions IS
  'Lot 91D : décisions de T1 (contrat t1-value-decisions-v1) sur les valeurs significatives des unités sources — STRUCTURED, COMPONENT_OR_CONTEXT, NOT_RETAINED (motif), UNDETERMINED — avec provenance, rattachements, validité serveur ; historique SUPERSEDED, jamais supprimé. Lues par COH-DOC-EXTRACT-CHAIN.';
COMMENT ON COLUMN document_value_decisions.unit_fingerprint IS
  'Empreinte du texte de l''unité source au moment de la décision : une unité réécrite différemment rend la décision obsolète pour le contrôle.';
COMMENT ON COLUMN document_value_decisions.validity IS
  'VALID : décision traçable (unité, valeur, rattachements, motif vérifiés par le serveur) ; INVALID : conservée avec invalid_reason, ne justifie jamais une omission.';
