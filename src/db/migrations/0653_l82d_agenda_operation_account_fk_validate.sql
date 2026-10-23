-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0653 : validation des contraintes posées NOT VALID par 0652
-- (lot 82, chantier 82D — CDC v5 O-1, E26).
--
-- Fichier séparé : la validation parcourt `agenda_items` sous un verrou
-- SHARE UPDATE EXCLUSIVE (ni lectures ni écritures bloquées), hors de la
-- transaction qui a posé la contrainte. 0652 a détaché les liens
-- intercomptes et ne pose que des valeurs admises : la validation ne peut pas
-- échouer. Idempotente (valider une contrainte déjà valide est sans effet).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE agenda_items VALIDATE CONSTRAINT agenda_items_operation_role_check;
ALTER TABLE agenda_items VALIDATE CONSTRAINT agenda_items_operation_role_origin_check;
ALTER TABLE agenda_items VALIDATE CONSTRAINT agenda_items_business_operation_account_fk;
