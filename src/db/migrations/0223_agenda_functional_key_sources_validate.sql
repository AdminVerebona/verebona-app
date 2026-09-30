-- Migration 0223 (liens source ↔ agenda, validation) : la contrainte
-- `agenda_item_sources_effect_type_check`, remplacée NOT VALID par
-- 0223_agenda_functional_key_sources.sql, est validée ici, dans une
-- transaction séparée : VALIDATE CONSTRAINT ne prend qu'un SHARE UPDATE
-- EXCLUSIVE (lectures et écritures continuent pendant le balayage).
-- Idempotente : valider une contrainte déjà valide est sans effet.
-- Ordre : après `_sources.sql` et `_sources_idx_1.sql` (ordre alphabétique).
SET LOCAL lock_timeout = '5s';
ALTER TABLE agenda_item_sources VALIDATE CONSTRAINT agenda_item_sources_effect_type_check;
