-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0256 : alimentation fiable de « À traiter » (lot 28, ticket P0).
--
-- 1. document_field_values — valeur RETENUE d'une donnée documentaire pilotée
--    par le catalogue `PROCESSING_RULES` (`rules-catalog.ts`) et qui n'a pas
--    de colonne dédiée sur `asset_files` : aujourd'hui `contractEndDate`
--    (DATA-CONTRACT-END) et `warrantyEndDate` (DATA-WARRANTY-END). Une règle
--    documentaire ajoutée au catalogue y trouve sa place sans migration ni
--    code propre (pont générique `document-rule-bridge.ts`).
--      · value_text      valeur normalisée (date ISO AAAA-MM-JJ, texte) ;
--      · origin          USER | DOCUMENT_EXTRACTION | RECONCILIATION | … ;
--      · user_validated  saisie ou validation explicite de l'utilisateur :
--                        JAMAIS remplacée automatiquement (P-05, §12.2) ;
--      · confidence      confiance de la valeur automatique (jamais affichée) ;
--      · evidence_ids    preuves ayant produit la valeur automatique.
--    Une ligne par (document, donnée). Les propositions par analyse
--    (`document_analysis_proposals`) restent ce qu'elles sont : un état de
--    run, remplacé à chaque analyse — d'où cette table durable.
--
-- 2. to_process_scan_runs — trace de chaque passage du balayage fonctionnel
--    « À traiter » (`to-process-scan.job.ts`, tâche planifiée interne
--    `to-process-scan`, ou route `/api/cron/to-process/scan`) : début, fin,
--    déclencheur, comptes parcourus, actions créées / mises à jour /
--    fermées, promotions de priorité, erreurs, curseur de reprise. Lue par
--    la page BO Exploitation (onglet Tâches planifiées). Distincte des
--    notifications « À traiter » (`notifications-to-process-scan`), qui ne
--    produisent aucune action.
--
-- Rattrapage des données existantes : aucun SQL ici — le balayage horaire
-- évalue les documents existants (rattachement, données requises) et crée
-- ou ferme les actions, par lots bornés, sans intervention.
--
-- Rétrocompatible : tables nouvelles ; l'ancien code les ignore.
-- Retour arrière : DROP TABLE document_field_values, to_process_scan_runs
-- (les actions « À traiter » ne référencent ni l'une ni l'autre).
-- Idempotente : IF NOT EXISTS. Index créés dans ce fichier (tables neuves,
-- vides : construction instantanée, aucun verrou sur une table existante).
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_field_values (
  id              BIGSERIAL   PRIMARY KEY,
  account_id      INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id         INTEGER     NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  field_key       TEXT        NOT NULL,
  value_text      TEXT,
  origin          TEXT        NOT NULL,
  user_validated  BOOLEAN     NOT NULL DEFAULT false,
  confidence      NUMERIC(4, 3),
  evidence_ids    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_field_values_confidence_chk
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS document_field_values_file_key_uidx
  ON document_field_values (file_id, field_key);

CREATE INDEX IF NOT EXISTS document_field_values_account_idx
  ON document_field_values (account_id, field_key);

COMMENT ON TABLE document_field_values IS
  'Valeur retenue des données documentaires du catalogue « À traiter » sans colonne dédiée (lot 28). user_validated = jamais remplacée automatiquement.';

CREATE TABLE IF NOT EXISTS to_process_scan_runs (
  id              BIGSERIAL   PRIMARY KEY,
  trigger         TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'running',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  duration_ms     INTEGER,
  accounts        INTEGER     NOT NULL DEFAULT 0,
  created         INTEGER     NOT NULL DEFAULT 0,
  updated         INTEGER     NOT NULL DEFAULT 0,
  closed          INTEGER     NOT NULL DEFAULT 0,
  promoted        INTEGER     NOT NULL DEFAULT 0,
  demoted         INTEGER     NOT NULL DEFAULT 0,
  errors          INTEGER     NOT NULL DEFAULT 0,
  error_sample    TEXT,
  next_cursor     INTEGER,
  CONSTRAINT to_process_scan_runs_status_chk
    CHECK (status IN ('running', 'ok', 'partial', 'error')),
  CONSTRAINT to_process_scan_runs_trigger_chk
    CHECK (trigger IN ('schedule', 'manual', 'startup', 'route'))
);

CREATE INDEX IF NOT EXISTS to_process_scan_runs_started_idx
  ON to_process_scan_runs (started_at DESC);

COMMENT ON TABLE to_process_scan_runs IS
  'Trace des passages du balayage fonctionnel « À traiter » (lot 28) : comptes, créées, mises à jour, fermées, promotions, erreurs. Lue par le BO Exploitation.';
