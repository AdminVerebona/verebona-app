-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0141 : bail d'exécution des jobs IA durables — reprise après arrêt
-- brutal et exécution unique (CDC BO IA NFR-003, SCR-08, §15.2).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- UN « RUNNING » N'EST PAS UNE PREUVE DE VIE
--
-- `claimNext` passe un job de PENDING à RUNNING. Si le processus meurt à cet
-- instant (redéploiement, OOM, crash), la ligne reste RUNNING pour toujours :
-- le boucleur ne prélève que des PENDING. Aucun mécanisme ne la reprenait.
--
-- Reprendre « tous les RUNNING » au démarrage serait faux en multi-instance :
-- un RUNNING peut être parfaitement vivant sur une autre instance.
--
-- D'où un BAIL : l'exécutant le renouvelle tant qu'il travaille
-- (`lease_expires_at`) ; un RUNNING dont le bail a expiré est abandonné, et
-- lui seul est repris.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- UN JETON D'EXÉCUTION PAR PRÉLÈVEMENT
--
-- `execution_id` est tiré à chaque prélèvement. Clôture, échec, renouvellement
-- du bail et contrôles d'écriture sont conditionnés à ce jeton : une exécution
-- dépossédée (reprise ailleurs après expiration, ou interrompue par une action
-- d'administration) ne peut plus rien écrire, ni passer le job en DONE.
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE ai_job_queue ADD COLUMN IF NOT EXISTS execution_id     UUID;
ALTER TABLE ai_job_queue ADD COLUMN IF NOT EXISTS worker_id        TEXT;
ALTER TABLE ai_job_queue ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE ai_job_queue ADD COLUMN IF NOT EXISTS heartbeat_at     TIMESTAMPTZ;
-- Nombre de reprises après abandon (distinct des échecs d'exécutant).
ALTER TABLE ai_job_queue ADD COLUMN IF NOT EXISTS recovered_count  INTEGER NOT NULL DEFAULT 0;

-- Recherche des RUNNING abandonnés.
CREATE INDEX IF NOT EXISTS ai_job_queue_running_lease_idx
  ON ai_job_queue(lease_expires_at)
  WHERE status = 'RUNNING';

COMMENT ON COLUMN ai_job_queue.execution_id IS
  'Jeton de l''exécution en cours, tiré à chaque prélèvement. Seule l''exécution qui le détient peut écrire et clore le job.';
COMMENT ON COLUMN ai_job_queue.lease_expires_at IS
  'Bail de l''exécution, renouvelé par l''exécutant. Expiré = exécution abandonnée, reprise automatique.';
