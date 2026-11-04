-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1090 : progression du RÉEXAMEN CIBLÉ des décisions T1, unité par
-- unité (lot 108K, ticket « Correctifs de conformité du lot 91D », §C et §D).
--
-- `document_value_review_units` : UNE ligne par unité source réexaminée (ou
-- tentée) pour une version de son texte (`unit_fingerprint`). Le réexamen
-- (`reviewDocumentValueDecisions`) traite TOUTES les unités en constat par
-- lots (plafonds techniques d'unités et de caractères par appel) ; la
-- progression survit d'un passage à l'autre : une unité n'est déclarée
-- « examinée » que si elle a réellement été transmise à T1 dans un lot dont
-- la réponse a été lue. Sert aussi au constat de NON-CONFORMITÉ de sortie
-- (réponse du réexamen sans tableau `valueDecisions` alors que le contrat est
-- porté) et à la Supervision (absence qui perdure).
--
--   status         EXAMINED       transmise à T1 et réponse lue ;
--                  FAILED         lot en échec technique (réessayé plus tard,
--                                 plafond de tentatives) ;
--                  TOO_LARGE      unité seule au-delà du plafond absolu d'un
--                                 appel : jamais tronquée, reste EN ATTENTE
--                                 (raison d'arrêt explicite) ;
--   output_status  PRESENT / EMPTY / ABSENT / MALFORMED / TRUNCATED (réponse
--                  du lot au regard du contrat t1-value-decisions-v1) ;
--   batch_no, batches : rang du lot et nombre de lots du passage ;
--   attempts       tentatives sur cette version de l'unité ;
--   decisions_written, prompt_version, ai_trace_id, origin : provenance.
--
-- Une nouvelle extraction réécrit l'unité (empreinte différente) : nouvelle
-- ligne, l'ancienne est conservée (historique). Aucun contenu de document :
-- identifiants d'unité, empreintes, statuts, compteurs.
--
-- Additive, idempotente, aucune reprise de données. Suit le document lors
-- d'un changement de compte (asset-account-transfer : `file_id`), supprimée
-- avec le compte ou le document (clés étrangères ON DELETE CASCADE). Table
-- neuve : index créés ici (création instantanée).
-- Retour arrière : DROP TABLE IF EXISTS document_value_review_units (le
-- réexamen revient à un seul lot par passage, comme au lot 91D).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_value_review_units (
  id                 BIGSERIAL   PRIMARY KEY,
  account_id         INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id            INTEGER     NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  extraction_id      BIGINT,
  source_unit_id     TEXT        NOT NULL,
  unit_fingerprint   TEXT        NOT NULL,
  status             TEXT        NOT NULL,
  output_status      TEXT,
  batch_no           INTEGER     NOT NULL DEFAULT 1,
  batches            INTEGER     NOT NULL DEFAULT 1,
  attempts           INTEGER     NOT NULL DEFAULT 1,
  decisions_written  INTEGER     NOT NULL DEFAULT 0,
  prompt_version     TEXT,
  ai_trace_id        TEXT,
  origin             TEXT        NOT NULL DEFAULT 'coherence-control',
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_value_review_units_status_chk CHECK (status IN ('EXAMINED', 'FAILED', 'TOO_LARGE')),
  CONSTRAINT document_value_review_units_output_chk CHECK (output_status IS NULL OR output_status IN ('PRESENT', 'EMPTY', 'ABSENT', 'MALFORMED', 'TRUNCATED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS document_value_review_units_uidx
  ON document_value_review_units (file_id, source_unit_id, unit_fingerprint);
CREATE INDEX IF NOT EXISTS document_value_review_units_account_idx
  ON document_value_review_units (account_id, file_id);

COMMENT ON TABLE document_value_review_units IS
  'Lot 108K : progression du réexamen ciblé des décisions T1 par unité source (examinée / en échec / trop grande), statut de la sortie T1 du lot, provenance. Historique conservé.';
