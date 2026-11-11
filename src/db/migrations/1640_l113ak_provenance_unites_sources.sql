-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1640 : provenance des faits T1 vers les unités sources, et preuves
-- par champ orphelines (lot 113AK, carte Trello #736 « T1 / Preuves — Réparer
-- les liens vers unités sources et assainir les preuves orphelines »).
--
--   · `document_fact_provenance_events` : JOURNAL des références constatées
--     invalides et de leur traitement, une ligne par (fait ou preuve, unité) :
--       subject      FACT (fait T1 → unité source) | EVIDENCE (preuve par champ
--                    → bien / document) ;
--       status       UNIT_MISSING (unité absente du MÊME document),
--                    SUPERSEDED_VERSION (fait actif d'une extraction remplacée),
--                    SOURCE_UNLINKED (document du fait dans un autre compte,
--                    preuve dont le document n'est plus rattaché au bien),
--                    CONTRADICTION (unité présente qui ne contient pas l'extrait
--                    cité, retrouvé ailleurs dans le document), RELINKED
--                    (provenance rétablie depuis les unités et l'extrait
--                    CONSERVÉS du même document), NOT_RECONSTRUCTIBLE
--                    (« provenance non reconstituable » : la valeur du fait est
--                    conservée, aucune citation fabriquée), ASSET_DELETED,
--                    ASSET_TRANSFERRED, DOCUMENT_DELETED, DOCUMENT_PURGED,
--                    DOCUMENT_TRANSFERRED, DOCUMENT_MERGED (preuve retirée de
--                    l'usage actif, ligne conservée) ;
--       phase        PERSISTENCE (écriture T1), BACKFILL (reprise historique de
--                    la couche A), CHECK (contrôle COH-DOC-FACT-PROVENANCE),
--                    CATCHUP (rattrapage BO), LIFECYCLE (suppression / fusion) ;
--       detail       état AVANT (identifiants d'unités, statut de cycle de vie)
--                    et APRÈS — la restauration d'une exécution du rattrapage
--                    s'en sert ; aucun contenu de document.
--     `file_id` n'a PAS de clé étrangère : une preuve peut citer un document
--     déjà purgé (c'est précisément ce que le journal qualifie). Suppression du
--     compte : cascade par `account_id`.
--   · `document_facts.provenance_status` : NULL (jamais qualifié, ou
--     provenance valide), RELINKED, NOT_RECONSTRUCTIBLE — lu par le contrôle
--     de cohérence et l'export diagnostic (écart subsistant et son motif).
--
-- Additive, idempotente, rejouable ; aucune reprise de données ici (rattrapage
-- BO « T1 : provenance des faits et preuves orphelines », simulable et
-- restaurable). Retour arrière : DROP TABLE document_fact_provenance_events ;
-- ALTER TABLE document_facts DROP COLUMN provenance_status (le code ignore leur
-- absence).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_fact_provenance_events (
  id              BIGSERIAL    PRIMARY KEY,
  account_id      INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id         INTEGER      NOT NULL,
  subject         TEXT         NOT NULL,
  fact_id         BIGINT,
  evidence_id     INTEGER,
  asset_id        INTEGER,
  extraction_id   INTEGER,
  source_unit_id  TEXT,
  status          TEXT         NOT NULL,
  cause           TEXT         NOT NULL,
  phase           TEXT         NOT NULL,
  run_id          UUID,
  detail          JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  reverted_at     TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_fact_provenance_events_subject_chk') THEN
    ALTER TABLE document_fact_provenance_events ADD CONSTRAINT document_fact_provenance_events_subject_chk
      CHECK (subject IN ('FACT', 'EVIDENCE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_fact_provenance_events_status_chk') THEN
    ALTER TABLE document_fact_provenance_events ADD CONSTRAINT document_fact_provenance_events_status_chk
      CHECK (status IN ('UNIT_MISSING', 'SUPERSEDED_VERSION', 'SOURCE_UNLINKED', 'CONTRADICTION', 'RELINKED', 'NOT_RECONSTRUCTIBLE',
                        'ASSET_DELETED', 'ASSET_TRANSFERRED', 'DOCUMENT_DELETED', 'DOCUMENT_PURGED', 'DOCUMENT_TRANSFERRED', 'DOCUMENT_MERGED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_fact_provenance_events_phase_chk') THEN
    ALTER TABLE document_fact_provenance_events ADD CONSTRAINT document_fact_provenance_events_phase_chk
      CHECK (phase IN ('PERSISTENCE', 'BACKFILL', 'CHECK', 'CATCHUP', 'LIFECYCLE'));
  END IF;
END $$;

-- Table neuve : index créés ici (instantané).
CREATE INDEX IF NOT EXISTS document_fact_provenance_events_file_idx ON document_fact_provenance_events (account_id, file_id, id);
CREATE INDEX IF NOT EXISTS document_fact_provenance_events_run_idx ON document_fact_provenance_events (run_id) WHERE run_id IS NOT NULL;

ALTER TABLE document_facts ADD COLUMN IF NOT EXISTS provenance_status TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_facts_provenance_status_chk') THEN
    ALTER TABLE document_facts ADD CONSTRAINT document_facts_provenance_status_chk
      CHECK (provenance_status IS NULL OR provenance_status IN ('RELINKED', 'NOT_RECONSTRUCTIBLE')) NOT VALID;
  END IF;
END $$;
