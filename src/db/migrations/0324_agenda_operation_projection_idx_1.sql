-- Migration 0324 (index 1/1) : événements d'agenda PROJETÉS depuis une Opération (lot 46, O7 — CDC Opérations V1 C16.1, C16.2) ;
-- nettoyage des projections orphelines et balayage horaire de convergence (`agenda-projection/service.ts`).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS agenda_items_projection_origin_idx
  ON agenda_items (account_id)
  WHERE projection_origin IS NOT NULL;
