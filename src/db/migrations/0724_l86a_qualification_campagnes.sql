-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0724 : campagnes de qualification par couple (lot 86A, CDC Pilotage
-- IA V2 phase P5 : QUAL-04, QUAL-05, R13, R31, R48 ; décision PO n° 13).
--
-- Une campagne = un passage de qualification (test manuel d'un couple depuis le
-- BO, ou campagne automatique de préproduction) : point de restauration 82E
-- exigé avant tout appel, comptes verrouillés le temps du rejeu, état final
-- (réussie / refusée / interrompue), battement pour détecter une interruption.
--
--   · ai_qualification_campaigns          une ligne par campagne ;
--   · ai_qualification_campaign_accounts  VERROU par compte : au plus une
--                                         campagne ouverte par compte (index
--                                         unique partiel) — jamais deux rejeux
--                                         concurrents sur les mêmes données.
--
-- Journaux techniques (aucun contenu de document) : exclus de l'export de
-- recette (motif dans recette-catalog.ts) et CONSERVÉS lors d'une restauration
-- (RESTORE_KEEP_CURRENT_TABLES : les rapports de tests restent consultables,
-- décision 13). Aucune colonne asset_id / file_id. Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_qualification_campaigns (
  id                 BIGSERIAL    PRIMARY KEY,
  kind               TEXT         NOT NULL,
  status             TEXT         NOT NULL DEFAULT 'PENDING',
  environment        TEXT         NOT NULL,
  trigger            TEXT,
  reason             TEXT,
  admin_user_id      INTEGER,
  config_version_id  INTEGER,
  candidate_version_id INTEGER,
  restore_point_id   TEXT,
  restore_point_at   TIMESTAMPTZ,
  thresholds_version TEXT         NOT NULL,
  request            JSONB        NOT NULL DEFAULT '{}'::jsonb,
  summary            JSONB        NOT NULL DEFAULT '{}'::jsonb,
  refusal            TEXT,
  error              TEXT,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  started_at         TIMESTAMPTZ,
  heartbeat_at       TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ,
  CONSTRAINT ai_qualification_campaigns_kind_chk CHECK (kind IN ('MANUAL', 'AUTO')),
  CONSTRAINT ai_qualification_campaigns_status_chk CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'REFUSED', 'INTERRUPTED', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS ai_qualification_campaigns_created_idx
  ON ai_qualification_campaigns (created_at DESC, id DESC);

COMMENT ON TABLE ai_qualification_campaigns IS
  'Lot 86A (Pilotage IA V2 P5) : campagnes de qualification par couple (test manuel BO ou automatique en préproduction). Point de restauration 82E exigé avant tout appel ; aucun effet externe ; conservée à la restauration.';
COMMENT ON COLUMN ai_qualification_campaigns.heartbeat_at IS
  'Dernier signe de vie : une campagne RUNNING sans battement depuis 30 min est INTERRUPTED (preuves non concluantes, verrous libérés — R13).';

CREATE TABLE IF NOT EXISTS ai_qualification_campaign_accounts (
  id            BIGSERIAL    PRIMARY KEY,
  campaign_id   BIGINT       NOT NULL REFERENCES ai_qualification_campaigns(id) ON DELETE CASCADE,
  account_id    INTEGER      NOT NULL,
  locked_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  released_at   TIMESTAMPTZ
);

-- Verrou : au plus une campagne OUVERTE par compte (QUAL-04 « empêcher les
-- campagnes concurrentes sur le même compte »).
CREATE UNIQUE INDEX IF NOT EXISTS ai_qualification_campaign_accounts_open_uniq
  ON ai_qualification_campaign_accounts (account_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS ai_qualification_campaign_accounts_campaign_idx
  ON ai_qualification_campaign_accounts (campaign_id);

COMMENT ON TABLE ai_qualification_campaign_accounts IS
  'Lot 86A : verrou par compte pendant une campagne de qualification (index unique partiel sur les verrous ouverts).';
