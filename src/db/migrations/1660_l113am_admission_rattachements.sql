-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1660 : rattachement documentaire — journal de la GARDE
-- D'ADMISSION des liens document ↔ bien (lot 113AM, carte Trello #739
-- « Une adresse de correspondance ne doit jamais rattacher à la Maison »).
--
-- `document_asset_link_admissions` (nouvelle) : une ligne par DÉCISION de la
-- garde partagée (`admitDocumentAssetLink`) prise avant une écriture
-- AUTOMATIQUE d'un rattachement (lien N-N `document_asset_links`, ou colonne
-- principale `asset_files.asset_id` reflétée par le déclencheur 0221) :
--   · write_kind   LINK | PRIMARY_COLUMN ;
--   · step / rule  étape décideuse (T1_PROJECTION, T1_PRIMARY_COLUMN,
--                  T1_RULE_BRIDGE, T3_DOCUMENT_ASSET, T3_ATTACHMENT_REVIEW,
--                  T3_FACT_TARGET, EQUIPMENT_LINK, REPAIR) et règle appliquée ;
--   · decision     ADMITTED (lien écrit ou rafraîchi), REFUSED (aucune
--                  écriture), REPAIRED (lien erroné retiré par le rattrapage
--                  BO, motif obligatoire), RESTORED (retrait annulé) ;
--   · reason_code  PROOF, USER_DECISION, ADDRESS_NOT_QUALIFIED,
--                  NO_ADMISSIBLE_PROOF, NO_JUSTIFICATION ;
--   · proofs       preuves examinées (natures, rôle qualifié des adresses,
--                  provenance fait / texte, scores) — JAMAIS une valeur
--                  d'adresse ni un extrait du document ;
--   · decisive_proof, rejected : preuve décisive, preuves écartées et motif.
-- Dédoublonnée : une même décision (document, cible, étape, issue, motif,
-- empreinte des preuves) incrémente `occurrences` / `last_seen_at` au lieu
-- d'ajouter une ligne (une réanalyse ne fait pas grossir le journal).
-- Lignes du rattrapage (run_id non nul) : une par lien retiré / restauré.
--
-- Additive, idempotente, rejouable ; aucune reprise de données. Suppression du
-- compte, du document ou du bien : cascade. Retour arrière : DROP TABLE
-- document_asset_link_admissions (la garde continue de s'appliquer, seul le
-- journal disparaît ; le rattrapage se désactive).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_asset_link_admissions (
  id                    BIGSERIAL    PRIMARY KEY,
  account_id            INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id               INTEGER      NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  asset_id              INTEGER      REFERENCES assets(id) ON DELETE CASCADE,
  equipment_id          INTEGER,
  substructure_id       INTEGER,
  link_id               BIGINT,
  write_kind            TEXT         NOT NULL DEFAULT 'LINK',
  step                  TEXT         NOT NULL,
  rule                  TEXT,
  origin                TEXT         NOT NULL,
  link_role             TEXT,
  decision              TEXT         NOT NULL,
  reason_code           TEXT         NOT NULL,
  decisive_proof        JSONB,
  proofs                JSONB        NOT NULL DEFAULT '[]'::jsonb,
  rejected              JSONB        NOT NULL DEFAULT '[]'::jsonb,
  digest                TEXT         NOT NULL,
  guard_version         INTEGER      NOT NULL DEFAULT 1,
  run_id                UUID,
  motive                TEXT,
  detail                JSONB        NOT NULL DEFAULT '{}'::jsonb,
  business_execution_id TEXT,
  occurrences           INTEGER      NOT NULL DEFAULT 1,
  first_seen_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_seen_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  reverted_at           TIMESTAMPTZ,
  CONSTRAINT document_asset_link_admissions_decision_chk CHECK (decision IN ('ADMITTED', 'REFUSED', 'REPAIRED', 'RESTORED')),
  CONSTRAINT document_asset_link_admissions_kind_chk CHECK (write_kind IN ('LINK', 'PRIMARY_COLUMN'))
);

-- Dédoublonnage des décisions de la garde (hors rattrapage).
CREATE UNIQUE INDEX IF NOT EXISTS document_asset_link_admissions_dedupe_uq
  ON document_asset_link_admissions (file_id, COALESCE(asset_id, 0), COALESCE(equipment_id, 0), COALESCE(substructure_id, 0),
                                     write_kind, step, decision, reason_code, digest)
  WHERE run_id IS NULL;

CREATE INDEX IF NOT EXISTS document_asset_link_admissions_account_file_idx
  ON document_asset_link_admissions (account_id, file_id);

CREATE INDEX IF NOT EXISTS document_asset_link_admissions_run_idx
  ON document_asset_link_admissions (run_id) WHERE run_id IS NOT NULL;
