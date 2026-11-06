-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1300 : CIL — alimentation documentaire des structures spécialisées
-- (lot 111U, ticket P1 « CIL : chaîne DPE et données structurées de bout en
-- bout »). Services : `src/services/cil/projection/*`, `src/services/cil/state/*`.
-- Matrice : `docs/cil/matrice-cil.md`.
--
-- 1. `energy_materials` (B5) reçoit sa PROVENANCE :
--      origin            USER | ADMIN | DOCUMENT — les lignes existantes ont été
--                        écrites par le seul formulaire (route energy-materials) :
--                        elles valent USER (défaut), donc PROTÉGÉES ;
--      installation_state  constate (décrit par un diagnostic) | installe
--                        (pose prouvée) | prevu (devis, projet) — NULL inconnu ;
--      source_file_id    document source d'une ligne DOCUMENT (preuve) ;
--      projection_key    clé d'idempotence d'une ligne DOCUMENT (`cil:mat:<poste>`) ;
--      evidence          preuves (faits T1, page, unités de la source) — jamais lu
--                        par les journaux techniques.
-- 2. `equipment_cil_specs` (B6) reçoit `field_origins` : origine PAR CHAMP
--    ({"energy_type":"DOCUMENT"}). Un champ renseigné sans origine = USER
--    (saisie de l'écran, protégée) — même règle que `readOrigin`.
-- 3. `cil_projection_journal` (table neuve) : état COURANT de chaque décision de
--    projection documentaire par bien et par clé (écrit, inchangé, protégé,
--    ambigu, conflit, abstention, recommandation non réalisée…), avec les
--    documents et faits sources. Sert l'idempotence (empreinte), le « à
--    confirmer » de l'onglet Informations, le contrôle de cohérence
--    COH-CIL-DOCUMENT-PROJECTION et le compte rendu BO. Aucun contenu de
--    document n'y est écrit (identifiants, codes, motifs seulement).
--
-- Additive, idempotente, rejouable. Retour arrière : DROP TABLE IF EXISTS
-- cil_projection_journal ; colonnes ignorées par le code antérieur (les lignes
-- DOCUMENT restent des matériaux ordinaires, modifiables par l'utilisateur).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE energy_materials
  ADD COLUMN IF NOT EXISTS origin             text NOT NULL DEFAULT 'USER',
  ADD COLUMN IF NOT EXISTS installation_state text,
  ADD COLUMN IF NOT EXISTS source_file_id     integer REFERENCES asset_files(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS projection_key     text,
  ADD COLUMN IF NOT EXISTS evidence           jsonb;

ALTER TABLE energy_materials DROP CONSTRAINT IF EXISTS energy_materials_origin_check;
ALTER TABLE energy_materials ADD CONSTRAINT energy_materials_origin_check
  CHECK (origin IN ('USER', 'ADMIN', 'DOCUMENT'));
ALTER TABLE energy_materials DROP CONSTRAINT IF EXISTS energy_materials_installation_state_check;
ALTER TABLE energy_materials ADD CONSTRAINT energy_materials_installation_state_check
  CHECK (installation_state IS NULL OR installation_state IN ('constate', 'installe', 'prevu'));

ALTER TABLE equipment_cil_specs
  ADD COLUMN IF NOT EXISTS field_origins jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS cil_projection_journal (
  id               BIGSERIAL    PRIMARY KEY,
  account_id       INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id         INTEGER      NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  -- `cil:mat:toiture`, `cil:eq:chauffage`, `cil:rec:<fichier>`…
  projection_key   TEXT         NOT NULL,
  -- energy_materials | equipments | equipment_cil_specs | energy_works | none
  target_table     TEXT         NOT NULL,
  target_id        INTEGER,
  status           TEXT         NOT NULL,
  reason           TEXT,
  source_file_ids  INTEGER[]    NOT NULL DEFAULT '{}',
  fact_ids         BIGINT[]     NOT NULL DEFAULT '{}',
  fingerprint      TEXT,
  detail           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  previous_status  TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT cil_projection_journal_status_check CHECK (status IN (
    'WRITTEN', 'UNCHANGED', 'PROTECTED', 'AMBIGUOUS', 'CONFLICT', 'ABSTAINED',
    'RECOMMENDATION_ONLY', 'RETRACTED', 'SOURCE_REMOVED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS cil_projection_journal_key_uidx ON cil_projection_journal (asset_id, projection_key);
CREATE INDEX IF NOT EXISTS cil_projection_journal_account_idx ON cil_projection_journal (account_id, status);

COMMENT ON TABLE cil_projection_journal IS
  'Lot 111U — état courant des décisions de projection documentaire CIL (B5/B6/B7) par bien et clé ; sans contenu documentaire.';
COMMENT ON COLUMN energy_materials.origin IS
  'Lot 111U — USER | ADMIN (protégées) | DOCUMENT (projection T3 déterministe depuis les faits T1 persistés).';
