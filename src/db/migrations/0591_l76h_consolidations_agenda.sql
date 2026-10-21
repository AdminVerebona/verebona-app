-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0591 : Opérations → Agenda — doublons d'interventions (lot 76H —
-- ticket « [P1] Opérations → Agenda — Corriger les doublons d'interventions »).
--
--   agenda_intervention_consolidations — JOURNAL de chaque convergence
--     d'agenda décidée à partir de l'identité établie par T3 :
--       ABSORB   un événement automatique T4 intact équivalent absorbé par
--                l'élément principal (image complète de l'élément, de ses
--                liens et de son historique ; preuves déplacées ; liens
--                ajoutés au principal ; cartes « À traiter » closes) ;
--       LINK     l'élément principal relié à l'Opération (Opération liée avant) ;
--       RETITLE  intitulé générique T4 remplacé par la description précise de
--                l'Opération (intitulé d'origine).
--     Une ligne restaurée (`restored_at`) n'est plus jamais rejouée par la
--     projection : l'événement redevient un choix de l'utilisateur
--     (arbitrage existant « À traiter »).
--   agenda_intervention_reprise_runs — exécutions du rattrapage ponctuel du
--     stock (simulation, application, restauration ; automatique au
--     démarrage ou lancé depuis le BO) : curseur, compteurs, rapport borné.
--
-- Tables neuves : aucune réécriture ; le code sonde leur présence (sans elles,
-- AUCUNE consolidation n'est appliquée — jamais de retrait sans trace).
-- Index dans 0591_..._idx_1 à _idx_3 (CONCURRENTLY). Idempotente.
-- Retour arrière : DROP TABLE IF EXISTS agenda_intervention_reprise_runs,
-- agenda_intervention_consolidations (comportement du lot 76G : abstention).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS agenda_intervention_consolidations (
  id                BIGSERIAL   PRIMARY KEY,
  account_id        INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  run_id            UUID,
  origin            TEXT        NOT NULL,
  kind              TEXT        NOT NULL,
  operation_id      BIGINT,
  principal_item_id INTEGER     NOT NULL,
  absorbed_item_id  INTEGER,
  reason            TEXT        NOT NULL,
  correlation_id    TEXT,
  detail            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  restored_at       TIMESTAMPTZ,
  restore_run_id    UUID,
  restore_detail    JSONB,
  CONSTRAINT agenda_intervention_consolidations_origin_chk CHECK (origin IN ('PROJECTION', 'REPRISE')),
  CONSTRAINT agenda_intervention_consolidations_kind_chk CHECK (kind IN ('ABSORB', 'LINK', 'RETITLE')),
  CONSTRAINT agenda_intervention_consolidations_absorbed_chk CHECK ((kind = 'ABSORB') = (absorbed_item_id IS NOT NULL))
);

COMMENT ON TABLE agenda_intervention_consolidations IS
  'Lot 76H : journal des convergences Opération → Agenda (absorption, lien, intitulé) — restaurable ligne à ligne.';

CREATE TABLE IF NOT EXISTS agenda_intervention_reprise_runs (
  id                UUID        PRIMARY KEY,
  mode              TEXT        NOT NULL,
  origin            TEXT        NOT NULL,
  account_filter    INTEGER,
  status            TEXT        NOT NULL DEFAULT 'running',
  cursor_account_id INTEGER     NOT NULL DEFAULT 0,
  restore_of        UUID,
  reason            TEXT,
  admin_user_id     INTEGER,
  counters          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  report            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  error             TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  CONSTRAINT agenda_intervention_reprise_runs_mode_chk CHECK (mode IN ('SIMULATE', 'APPLY', 'RESTORE')),
  CONSTRAINT agenda_intervention_reprise_runs_origin_chk CHECK (origin IN ('AUTO', 'BO')),
  CONSTRAINT agenda_intervention_reprise_runs_status_chk CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted'))
);

COMMENT ON TABLE agenda_intervention_reprise_runs IS
  'Lot 76H : exécutions du rattrapage ponctuel des doublons d''interventions (simulation, application, restauration).';
