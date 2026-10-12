-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0319 : validation des contraintes posées NOT VALID par 0318
-- (lot 39, O1).
--
-- Fichier séparé : la validation parcourt `agenda_items` sous un verrou
-- SHARE UPDATE EXCLUSIVE, qui n'empêche ni lectures ni écritures — à
-- condition de ne pas s'exécuter dans la transaction qui a posé la
-- contrainte (verrou plus fort, tenu jusqu'à la fin). Les colonnes sont
-- neuves et nulles : la validation ne peut pas échouer.
-- Idempotente (valider une contrainte déjà valide est sans effet).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE agenda_items VALIDATE CONSTRAINT agenda_items_business_operation_fk;
ALTER TABLE agenda_items VALIDATE CONSTRAINT agenda_items_projection_origin_check;
