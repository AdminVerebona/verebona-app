-- Migration 0235 (index 1/1) : cumul mensuel du coût IA d'un compte (lot 22).
-- Lu par la passerelle avant chaque appel soumis à un plafond
-- (`account-cost-cap`) : (account_id, created_at) avec coût et usage inclus,
-- lecture d'index seule, bornée au compte et au mois.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne peut pas
-- s'exécuter dans une transaction. Aucun verrou bloquant les écritures de
-- traces pendant la construction. Idempotente ; un index laissé INVALIDE par
-- une construction interrompue est reconstruit au démarrage
-- (`migration-index.ts`).
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_usage_event_account_created_idx ON ai_usage_event (account_id, created_at) INCLUDE (cost_micros, use_case_code) WHERE account_id IS NOT NULL;
