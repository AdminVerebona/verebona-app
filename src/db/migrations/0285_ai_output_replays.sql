-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0285 : rejeu automatique des documents en échec INVALID_OUTPUT —
-- lot 33D (ticket « réussite malgré les désalignements », §29, §30, cas 8).
--
-- Après le déploiement d'un correctif de la résolution des sorties
-- (`OUTPUT_RESOLUTION_VERSION`), la tâche planifiée interne
-- `t1-invalid-output-replay` remet en file T1 les documents dont l'analyse a
-- échoué sur une sortie invalide, sans action de l'utilisateur. Cette table
-- rend le rejeu IDEMPOTENT : au plus UN rejeu par document et par version de
-- résolution (contrainte unique), avec la signature d'échec d'origine et
-- l'issue constatée. L'analyse elle-même est idempotente (faits, échéances,
-- liaisons remplacés, jamais dupliqués) : rejouer ne crée aucun doublon.
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_output_replays (
  id                  BIGSERIAL    PRIMARY KEY,
  file_id             INTEGER      NOT NULL,
  account_id          INTEGER      NOT NULL,
  resolution_version  TEXT         NOT NULL,
  signature           TEXT,
  failure_source      TEXT         NOT NULL DEFAULT 'diagnostic',
  status              TEXT         NOT NULL DEFAULT 'ENQUEUED',
  detail              TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_output_replays_file_version_uq UNIQUE (file_id, resolution_version),
  CONSTRAINT ai_output_replays_status_chk CHECK (status IN ('ENQUEUED', 'SKIPPED', 'SUCCEEDED', 'FAILED_AGAIN'))
);

COMMENT ON TABLE ai_output_replays IS
  'Rejeu automatique des documents en échec INVALID_OUTPUT — un rejeu par document et par version de résolution (lot 33D).';
