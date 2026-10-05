-- Migration 0237 (index 1/1) : export CSV des métriques agrégées de
-- l'assistant (CDC Assistant §32.6, lot 23). L'export lit `verebona_ai_runs`
-- par PÉRIODE seule (tous comptes) : les index existants commencent par
-- `account_id` ou `resolved_model_id` et ne servent pas ce filtre.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne peut pas
-- s'exécuter dans une transaction. Aucun verrou bloquant les écritures de
-- traces pendant la construction. Idempotente ; un index laissé INVALIDE par
-- une construction interrompue est reconstruit au démarrage
-- (`migration-index.ts`).
CREATE INDEX CONCURRENTLY IF NOT EXISTS verebona_ai_runs_created_at_idx ON verebona_ai_runs (created_at);
