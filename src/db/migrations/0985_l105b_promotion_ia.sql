-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0985 : promotion automatique IA sécurisée (lot 105B, ticket P1
-- « IA auto-amélioration : promotion sur preuves, reprise, surveillance »).
-- Services : `src/services/ai/qualification/promotion-gate.ts`,
-- `promotion-context.ts`, `post-activation.ts`, `promotion-watch.ts`.
--
--   · ai_config_versions.candidate_state : + 'BLOCKED_A1' — candidate
--     qualifiée MÉTIER mais refusée par le verrou A1 (couverture du corpus) :
--     jamais laissée « QUALIFIED » activable, jamais un faux REFUSED métier.
--   · ai_config_versions.candidate_promotion (JSONB, {} par défaut) : écrit par
--     le SERVEUR seulement — qualification métier (état, campagne, preuves),
--     décision A1 (journal, empreinte de contexte), relances bornées après
--     changement d'A1, surveillance post-activation. Séparés, jamais fusionnés.
--   · ai_qualification_campaigns.kind : + 'POST_CHECK' — rejeu des cas
--     certifiés après activation (ancienne version ↔ candidate, mêmes cas).
--   · ai_qualification_cases.decisions (JSONB) : décisions lues sur la sortie
--     (paires adversariales revérifiées depuis la base à l'activation).
--   · ai_promotion_events : journal append-only de la promotion automatique
--     (revalidation à la frontière d'activation et dans la transaction,
--     blocages et relances A1, contrôles post-activation, retours arrière),
--     avec la version de référence (empreintes) de chaque décision.
--
-- Table technique SANS compte (aucune colonne account_id, asset_id, file_id),
-- conservée à la restauration (journal). Additive et idempotente : colonnes
-- nullables / défaut constant (aucune réécriture), contraintes remplacées
-- seulement si elles ne contiennent pas déjà la nouvelle valeur ; table neuve :
-- index créés avec elle. Retour arrière : DROP TABLE ai_promotion_events ;
-- ALTER TABLE ai_config_versions DROP COLUMN candidate_promotion ; remettre les
-- contraintes 0861 (après avoir repassé les BLOCKED_A1 en INCONCLUSIVE).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_config_versions ADD COLUMN IF NOT EXISTS candidate_promotion JSONB NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN ai_config_versions.candidate_promotion IS
  'Lot 105B : promotion automatique d''une candidate (écrit par le serveur) — qualification métier, décision A1, relances bornées, surveillance post-activation. Jamais une preuve fournie par l''appelant.';

ALTER TABLE ai_qualification_cases ADD COLUMN IF NOT EXISTS decisions JSONB;
COMMENT ON COLUMN ai_qualification_cases.decisions IS
  'Lot 105B : décisions lues sur la sortie (oracle) — paires adversariales revérifiées depuis la base à l''activation.';

DO $$
BEGIN
  IF to_regclass('ai_config_versions') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_config_versions'::regclass
                AND conname = 'ai_config_versions_candidate_state_chk' AND pg_get_constraintdef(oid) NOT LIKE '%BLOCKED_A1%') THEN
      ALTER TABLE ai_config_versions DROP CONSTRAINT ai_config_versions_candidate_state_chk;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_config_versions'::regclass
                    AND conname = 'ai_config_versions_candidate_state_chk') THEN
      ALTER TABLE ai_config_versions ADD CONSTRAINT ai_config_versions_candidate_state_chk CHECK (
        candidate_state IS NULL OR candidate_state IN ('CREATED', 'QUALIFYING', 'QUALIFIED', 'REFUSED', 'INCONCLUSIVE', 'ACTIVATED', 'NOT_CHOSEN', 'SUSPENDED', 'BLOCKED_A1'));
    END IF;
  END IF;

  IF to_regclass('ai_qualification_campaigns') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_qualification_campaigns'::regclass
                AND conname = 'ai_qualification_campaigns_kind_chk' AND pg_get_constraintdef(oid) NOT LIKE '%POST_CHECK%') THEN
      ALTER TABLE ai_qualification_campaigns DROP CONSTRAINT ai_qualification_campaigns_kind_chk;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_qualification_campaigns'::regclass
                    AND conname = 'ai_qualification_campaigns_kind_chk') THEN
      ALTER TABLE ai_qualification_campaigns ADD CONSTRAINT ai_qualification_campaigns_kind_chk
        CHECK (kind IN ('MANUAL', 'AUTO', 'CONFORMITY', 'POST_CHECK'));
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_promotion_events (
  id                    BIGSERIAL    PRIMARY KEY,
  environment           TEXT         NOT NULL,
  kind                  TEXT         NOT NULL,
  candidate_version_id  BIGINT,
  campaign_id           BIGINT,
  treatment             TEXT,
  allowed               BOOLEAN,
  code                  TEXT,
  message               TEXT         NOT NULL DEFAULT '',
  reference             JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_promotion_events_kind_chk CHECK (kind IN (
    'ACTIVATION_GATE', 'ACTIVATION_TX', 'A1_BLOCKED', 'A1_RELAUNCH', 'A1_WAITING', 'ACTIVATED',
    'POST_CHECK', 'POST_ALERT', 'ROLLBACK', 'ROLLBACK_FAILED', 'WATCH_END'))
);
CREATE INDEX IF NOT EXISTS ai_promotion_events_created_idx ON ai_promotion_events (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ai_promotion_events_candidate_idx ON ai_promotion_events (candidate_version_id, id DESC);
COMMENT ON TABLE ai_promotion_events IS
  'Lot 105B : journal de la promotion automatique IA en préproduction (revalidation d''activation, blocages et relances A1, surveillance post-activation, retours arrière) avec la version de référence. Append-only.';
