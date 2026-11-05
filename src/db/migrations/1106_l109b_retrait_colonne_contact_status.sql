-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1106 : retrait physique de suppliers.contact_status (lot 109B,
-- temps 2, livré avec le lot 110).
--
-- Le lot 109 (temps 1, migration 1105) a cessé de lire et d'écrire cette
-- colonne et l'a neutralisée (ni défaut, ni obligation). Plus aucune version
-- de l'application ne la nomme : PRÉREQUIS, le lot 109 doit être en service
-- avant le déploiement du lot 110 (pendant le postdeploy, c'est la version
-- précédente qui sert le trafic).
-- Idempotente (colonne absente : rien).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE suppliers DROP COLUMN IF EXISTS contact_status;
