-- Migration 0127 — Verrou de tâche planifiée partagé entre instances
--
-- ═════════════════════════════════════════════════════════════════════════════
-- POURQUOI
--
-- `analysis-recovery.service` se protégeait par un booléen de module. Ce verrou
-- ne vaut que dans un processus : deux instances lancent chacune leur tour,
-- relancent les mêmes documents et consomment deux fois le crédit d'analyse.
--
-- Un bail daté règle le cas quel que soit le nombre d'instances. Si un
-- processus meurt, le bail expire et le travail reprend — là où un verrou en
-- mémoire perdu bloquerait jusqu'au redémarrage.
--
-- Idempotente, et sans effet sur les données existantes.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS job_locks (
  name          TEXT PRIMARY KEY,
  locked_until  TIMESTAMPTZ NOT NULL,
  locked_by     TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE job_locks IS
  'Baux de tâches planifiées. Une ligne par tâche ; le bail expire seul, '
  'aucune reprise manuelle n''est nécessaire après un arrêt brutal.';
