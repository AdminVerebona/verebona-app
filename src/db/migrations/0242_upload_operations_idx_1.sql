-- Migration 0241 (index 1/1) : unicité de l'identifiant d'opération de dépôt
-- par utilisateur (APP-PERF-30). Deux `presign` simultanés avec la même clé
-- ne peuvent pas créer deux lignes : le second échoue (23505) et relit la
-- ligne du premier. Partiel : les lignes sans clé (existantes, vignettes,
-- anciens clients) n'entrent pas dans l'index.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne peut pas
-- s'exécuter dans une transaction ; aucun verrou bloquant les dépôts pendant
-- la construction. Idempotente ; un index laissé INVALIDE est reconstruit au
-- démarrage (`migration-index.ts`).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS asset_files_user_upload_operation_uidx ON asset_files (user_id, upload_operation_id) WHERE upload_operation_id IS NOT NULL;
