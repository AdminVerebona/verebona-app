-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0651 : retrait de la tâche planifiée `ai-call-diagnostics-purge`
-- — lot 82C (décisions PO n° 01 et 10 du 22/10 : aucune purge par ancienneté
-- des diagnostics, sorties modèle et rapports d'exécution IA).
--
-- La tâche est retirée du catalogue ; son état partagé, devenu sans objet,
-- est supprimé pour qu'elle n'apparaisse plus au BO (Supervision › Tâches
-- planifiées). Aucune donnée métier touchée. Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DELETE FROM scheduled_task_state WHERE code = 'ai-call-diagnostics-purge';
