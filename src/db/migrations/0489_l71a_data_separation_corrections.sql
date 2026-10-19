-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0489 : journal des corrections « séparation bien / équipement »
-- (lot 71A — BUG P1 « confusion des données entre biens et équipements »).
--
-- Le rattrapage BO (Exploitation › Rattrapages › « Séparation bien /
-- équipement ») corrige, après VÉRIFICATION DE PROVENANCE, les valeurs
-- héritées entre un bien et ses équipements et rattache rétroactivement les
-- documents aux équipements. Chaque correction APPLIQUÉE est tracée ici, une
-- ligne par objet touché : identifiant d'exécution, motif saisi, état avant /
-- après. La simulation n'écrit rien.
--
--   kind          ASSET_EVIDENCE_WITHDRAWN | EQUIPMENT_EVIDENCE_WITHDRAWN |
--                 AGENDA_PURCHASE_MOVED | DOCUMENT_EQUIPMENT_LINKED
--   subject_type  FIELD_EVIDENCE | ASSET | EQUIPMENT | DOCUMENT
--
-- Idempotente (IF NOT EXISTS). Table nouvelle, vide : aucun verrou sur une
-- table existante. Retour arrière : DROP TABLE (aucune autre donnée n'en dépend).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS data_separation_corrections (
  id            bigserial PRIMARY KEY,
  run_id        uuid NOT NULL,
  account_id    integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  subject_type  text NOT NULL,
  subject_id    bigint NOT NULL,
  field_key     text,
  before_value  jsonb,
  after_value   jsonb,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_separation_corrections_kind_chk CHECK (kind IN (
    'ASSET_EVIDENCE_WITHDRAWN', 'EQUIPMENT_EVIDENCE_WITHDRAWN', 'AGENDA_PURCHASE_MOVED', 'DOCUMENT_EQUIPMENT_LINKED')),
  CONSTRAINT data_separation_corrections_subject_chk CHECK (subject_type IN ('FIELD_EVIDENCE', 'ASSET', 'EQUIPMENT', 'DOCUMENT'))
);

CREATE INDEX IF NOT EXISTS data_separation_corrections_run_idx ON data_separation_corrections (run_id);
CREATE INDEX IF NOT EXISTS data_separation_corrections_account_idx ON data_separation_corrections (account_id, created_at DESC);

COMMENT ON TABLE data_separation_corrections IS
  'Lot 71A : corrections appliquées par le rattrapage « Séparation bien / équipement » (BO), avec motif et état avant / après.';
