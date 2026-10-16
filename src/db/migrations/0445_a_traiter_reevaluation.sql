-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0445 : réévaluation RÉTROACTIVE des cartes « À traiter »
-- documentaires (lot 61 — ticket « [P1] À traiter — Fiabiliser la pertinence
-- des cartes », §6 ; ticket « BUG P1 — écarts résiduels du lot 58B »,
-- livraison « réévaluation des cartes existantes »).
--
--   to_process_relevance_campaigns — une campagne = un passage complet sur
--       les cartes documentaires actives, exécuté par la tâche planifiée
--       interne `to-process-relevance-reevaluation` (lot 25), par lots
--       bornés, avec curseur (reprise après redémarrage). Bilan AVANT / APRÈS
--       (cartes actives par règle) et issues : conservées, résolues
--       automatiquement, différées, retirées (sans pertinence), remplacées
--       par une action réelle, en erreur. Lu par le BO (File d'attente IA ›
--       Pertinence « À traiter »).
--
--   to_process_relevance_campaign_items — issue de CHAQUE carte examinée
--       (règle, nature avant, issue, motif) : audit. Aucune carte n'est
--       supprimée physiquement ; la décision de l'utilisateur est conservée.
--
-- Tables neuves (vides) : contraintes créées avec la table. Index dans
-- 0445_..._idx_1 (CONCURRENTLY). Idempotente. Retour arrière : DROP TABLE IF
-- EXISTS … (la tâche signale alors « migration absente » et ne fait rien).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS to_process_relevance_campaigns (
  id               BIGSERIAL   PRIMARY KEY,
  code             TEXT        NOT NULL UNIQUE,
  engine_version   TEXT        NOT NULL,
  -- RUNNING | DONE | ERROR
  status           TEXT        NOT NULL DEFAULT 'RUNNING',
  trigger_code     TEXT        NOT NULL DEFAULT 'schedule',
  requested_by     INTEGER,
  cursor_action_id INTEGER     NOT NULL DEFAULT 0,
  -- Cartes actives par règle au lancement / à la fin : {ruleCode: n}.
  before_counts    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  after_counts     JSONB,
  -- {KEPT, AUTO_RESOLVED, DEFERRED, REMOVED, REPLACED_BY_INTERVENTION, ERROR, examined}
  outcomes         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  error_sample     TEXT,
  runs             INTEGER     NOT NULL DEFAULT 0,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_at      TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  CONSTRAINT to_process_relevance_campaigns_status_chk CHECK (status IN ('RUNNING', 'DONE', 'ERROR'))
);

CREATE TABLE IF NOT EXISTS to_process_relevance_campaign_items (
  id           BIGSERIAL   PRIMARY KEY,
  campaign_id  BIGINT      NOT NULL REFERENCES to_process_relevance_campaigns(id) ON DELETE CASCADE,
  action_id    INTEGER     NOT NULL,
  account_id   INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id      INTEGER     NOT NULL,
  rule_code    TEXT        NOT NULL,
  kind_before  TEXT,
  outcome      TEXT        NOT NULL,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT to_process_relevance_campaign_items_uniq UNIQUE (campaign_id, action_id)
);

COMMENT ON TABLE to_process_relevance_campaigns IS
  'Lot 61 : campagnes de réévaluation rétroactive des cartes « À traiter » documentaires (bilan avant / après, BO).';
COMMENT ON TABLE to_process_relevance_campaign_items IS
  'Lot 61 : issue de chaque carte examinée par une campagne de réévaluation (audit).';
