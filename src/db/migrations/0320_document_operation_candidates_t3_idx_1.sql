-- Migration 0320 (index 1/2) : clé locale d'un candidat unique parmi les
-- candidats ACTIFS de l'extraction (C3.2 ; remplace l'index complet de la 0317,
-- incompatible avec la réanalyse — `extraction_id` n'est pas une version).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`). Garde-fou : la persistance supersède les actifs
-- avant d'insérer, dans la même transaction.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS document_operation_candidates_active_key_uidx
  ON document_operation_candidates (extraction_id, candidate_key)
  WHERE status = 'ACTIVE';
