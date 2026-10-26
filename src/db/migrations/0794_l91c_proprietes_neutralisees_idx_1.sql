-- Migration 0794 (index 1/1) : lot 91C — faits encore neutralisés par l'ancienne
-- règle « acquisition sans preuve d'achat » (ACQUISITION_WITHOUT_PURCHASE_PROOF),
-- lus par le rattrapage des propriétés (tâche planifiée
-- `projection-property-evidence-reprise` et Exploitation › Rattrapages).
-- Index PARTIEL : quelques lignes seulement, jamais toute la table des faits.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la sélection parcourt les faits actifs — plus
-- lent, jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_facts_l91c_neutralized_idx
  ON document_facts (id) WHERE status = 'active' AND canonical_key IS NULL AND projection_rule = 'ACQUISITION_WITHOUT_PURCHASE_PROOF';
