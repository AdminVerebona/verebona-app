-- Lot 84A — CDC « Opérations v5 », lot O-10 : suppression définitive de
-- l'ancien modèle Sinistres, ÉTAPE FINALE du rattrapage BO « Sinistres :
-- nettoyage de l'ancien modèle » (lot 83D).
--
-- AUCUN DROP de l'ancien modèle ICI : une migration s'applique dès le
-- déploiement, AVANT que le PO ait pu lancer le nettoyage au BO. La
-- suppression des tables `business_operation_claim_actions`,
-- `business_operation_claim_exchanges`, `business_operation_claim_migration_marks`
-- et des colonnes `business_operations.parent_operation_id` (clé étrangère,
-- index, contrainte) et `asset_additional_infos.claim_json` est faite par
-- l'action BO « Finaliser » (BO › Exploitation › Rattrapages › bloc 7,
-- étape 2), possible seulement quand le nettoyage a été appliqué sur TOUS les
-- comptes, avec un point de restauration de moins de 24 h, après simulation
-- (`src/services/business-operations/claims/legacy-finalize.ts`).
--
-- Cette migration autorise seulement les modes de la finalisation dans le
-- journal d'exécution du rattrapage (0672), qui sert aussi de trace de la
-- finalisation (table conservée lors d'une restauration de point).
--
-- Idempotente : DROP CONSTRAINT IF EXISTS puis ADD (même nom).
SET LOCAL lock_timeout = '5s';

ALTER TABLE claim_legacy_cleanup_runs DROP CONSTRAINT IF EXISTS claim_legacy_cleanup_runs_mode_chk;
ALTER TABLE claim_legacy_cleanup_runs ADD CONSTRAINT claim_legacy_cleanup_runs_mode_chk
  CHECK (mode IN ('SIMULATE', 'APPLY', 'RESTORE', 'REFUSED', 'FINALIZE_SIMULATE', 'FINALIZE'));

COMMENT ON TABLE claim_legacy_cleanup_runs IS
  'Lots 83D / 84A : exécutions du rattrapage BO « Sinistres : nettoyage de l''ancien modèle » (simulation, application, restauration, refus) et de sa FINALISATION (suppression définitive des tables et colonnes de l''ancien modèle, O-10).';
