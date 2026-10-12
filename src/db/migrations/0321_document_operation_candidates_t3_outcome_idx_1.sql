-- Migration 0321 (index 1/1) : candidats ACTIFS en attente de résolution
-- (HOLD_UNRESOLVED) d'un compte — reprise bornée par T3 quand une Opération
-- du compte change ou qu'un bien ciblé est modifié (C4, C5).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_operation_candidates_t3_hold_idx
  ON document_operation_candidates (account_id, file_id)
  WHERE status = 'ACTIVE' AND t3_outcome = 'HOLD_UNRESOLVED';
