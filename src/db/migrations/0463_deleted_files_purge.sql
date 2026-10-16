-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0463 : purge planifiée des fichiers supprimés + pilotage BO des
-- tâches planifiées (lot 65A, décision PO du 16/10/2026).
--
-- La purge S3 des fichiers supprimés depuis plus de 30 jours (`cleanup-job`)
-- n'était lancée par rien. Elle devient la tâche planifiée interne
-- `deleted-files-purge` (quotidienne). Deux besoins d'exploitation communs à
-- toutes les tâches, exprimés par le PO :
--
--   · last_note            dernier compte rendu de l'exécution (résumé court,
--                          sans donnée personnelle) affiché dans le BO ›
--                          Exploitation › Tâches planifiées — jusqu'ici dans
--                          les journaux du conteneur seulement ;
--   · admin_disabled       tâche suspendue depuis le BO (ni planifiée ni
--     admin_disabled_at    exécutable à la main tant qu'elle l'est) ; date et
--     admin_disabled_by    administrateur. Les tâches CRITIQUES ne sont pas
--                          suspendables depuis le BO (refusé par l'application).
--
-- Rétrocompatible : colonnes nouvelles, ignorées par l'ancien code ; le
-- nouveau code les lit sans en dépendre (une base sans ces colonnes garde le
-- comportement d'avant). Retour arrière : colonnes laissées en place.
-- Idempotente : ADD COLUMN IF NOT EXISTS.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE scheduled_task_state ADD COLUMN IF NOT EXISTS last_note text;
ALTER TABLE scheduled_task_state ADD COLUMN IF NOT EXISTS admin_disabled boolean NOT NULL DEFAULT false;
ALTER TABLE scheduled_task_state ADD COLUMN IF NOT EXISTS admin_disabled_at timestamptz;
ALTER TABLE scheduled_task_state ADD COLUMN IF NOT EXISTS admin_disabled_by integer;
