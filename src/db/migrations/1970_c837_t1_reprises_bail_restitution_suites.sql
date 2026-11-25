-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1970 : RÉSIDUS DU LOT 115H — demandes de reprise T1 sous bail,
-- restitution atomique, suites corrélées des campagnes (carte Trello #837,
-- points A3, B1, B2, B3 et D1 ; suite de la migration 1805 du lot 115H, carte
-- #785).
--
--   · `t1_requeue_requests` complétée, additivement :
--       lease_token / lease_expires_at  BAIL de la demande pendant sa
--                          réservation : une seule exécution tient une demande
--                          RESERVED ; toute écriture d'étape, la consommation
--                          et la restitution sont conditionnées par le jeton
--                          (fencing). Une demande dont le bail a expiré est
--                          reprise ou restituée, jamais doublée ;
--       cycles             nombre de réservations successives de la MÊME
--                          demande canonique (refus, restitution, échec puis
--                          nouvelle tentative) ;
--       history            trace immuable des cycles précédents (état, étapes,
--                          travail, motif, provenance) : rien n'est effacé
--                          quand une demande repart ;
--       campaign_ref       campagne de réévaluation qui a programmé la reprise
--                          (`t1-coverage-reassessment:vN`) — corrélation
--                          EXPLICITE campagne → demande → travail → appels.
--
--   · `t1_campaign_followups` : une ligne par SUITE réellement exécutée d'une
--     campagne (réparation textuelle ciblée, relecture du fichier, remise en
--     file T1), écrite par l'exécution elle-même, à sa fin. Elle porte la
--     corrélation explicite (campagne, demande, travail, exécution métier),
--     les appels et le coût RENDUS (coût inconnu compté à part, jamais 0) et
--     l'issue MÉTIER (succès, échec, unités réparées, résidus restants).
--     Immuable : une suite n'est jamais réécrite.
--
-- Additive, idempotente, rejouable, NON DESTRUCTIVE ; aucune reprise de données
-- (les demandes existantes gardent leur état ; une demande sans bail est
-- considérée comme à bail expiré). Retour arrière : ALTER TABLE … DROP COLUMN
-- et DROP TABLE t1_campaign_followups (le code rend alors la remise en file
-- INDISPONIBLE de façon visible — fail-closed — et le bilan dit « suites non
-- corrélables » au lieu de 0).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

-- ── 1. Bail, cycles et historique des demandes de reprise ────────────────────
DO $$
BEGIN
  IF to_regclass('t1_requeue_requests') IS NOT NULL THEN
    ALTER TABLE t1_requeue_requests ADD COLUMN IF NOT EXISTS lease_token UUID;
    ALTER TABLE t1_requeue_requests ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
    ALTER TABLE t1_requeue_requests ADD COLUMN IF NOT EXISTS cycles INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE t1_requeue_requests ADD COLUMN IF NOT EXISTS history JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE t1_requeue_requests ADD COLUMN IF NOT EXISTS campaign_ref TEXT;
    CREATE INDEX IF NOT EXISTS t1_requeue_requests_lease_idx
      ON t1_requeue_requests (lease_expires_at) WHERE state = 'RESERVED';
    CREATE INDEX IF NOT EXISTS t1_requeue_requests_campaign_idx
      ON t1_requeue_requests (campaign_ref) WHERE campaign_ref IS NOT NULL;
    COMMENT ON COLUMN t1_requeue_requests.lease_token IS
      'Carte #837 (A3, B2) : jeton de la réservation en cours — toute écriture de la demande et toute consommation sont conditionnées par lui.';
    COMMENT ON COLUMN t1_requeue_requests.history IS
      'Carte #837 (B2) : cycles précédents de la demande canonique (état, étapes, travail, motif, provenance) — jamais effacés.';
    COMMENT ON COLUMN t1_requeue_requests.campaign_ref IS
      'Carte #837 (D1) : campagne de réévaluation à l''origine de la reprise — corrélation explicite campagne → demande → travail → appels.';
  END IF;
END $$;

-- ── 2. Suites exécutées des campagnes (corrélation explicite, coûts rendus) ─
CREATE TABLE IF NOT EXISTS t1_campaign_followups (
  id                   BIGSERIAL    PRIMARY KEY,
  campaign_ref         TEXT         NOT NULL,
  account_id           INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id              INTEGER      NOT NULL,
  kind                 TEXT         NOT NULL,
  request_id           BIGINT,
  job_id               BIGINT,
  business_execution_id TEXT,
  calls                INTEGER,
  calls_failed         INTEGER,
  cost_micros          BIGINT,
  cost_unknown_calls   INTEGER,
  result               TEXT,
  business_success     BOOLEAN,
  units_attempted      INTEGER,
  units_repaired       INTEGER,
  residual_units       INTEGER,
  quality_before       TEXT,
  quality_after        TEXT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS t1_campaign_followups_campaign_idx
  ON t1_campaign_followups (campaign_ref, kind);
CREATE INDEX IF NOT EXISTS t1_campaign_followups_file_idx
  ON t1_campaign_followups (account_id, file_id);

COMMENT ON TABLE t1_campaign_followups IS
  'Carte #837 (D1, D2) : suites RÉELLEMENT exécutées d''une campagne de réévaluation T1 (réparation, relecture, remise en file), corrélées explicitement et immuables — appels, coût rendu (inconnu ≠ 0) et issue métier. Aucun contenu de document.';
