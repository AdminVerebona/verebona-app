-- Migration 0218 (index 2/2) : document_facts (cible) — CDC 15 T1-04, T1-05.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne peut pas
-- s'exécuter dans une transaction, et une requête à instruction unique n'en
-- ouvre pas (`ensureMigrations` passe le fichier tel quel).
-- Idempotente (IF NOT EXISTS). Index INVALIDE après interruption : le
-- supprimer (DROP INDEX CONCURRENTLY <nom>) puis redémarrer.
-- Index partiel : seuls les faits dont la cible est vérifiée y figurent.
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_facts_target_idx ON document_facts (target_type, target_entity_id) WHERE target_entity_id IS NOT NULL;
