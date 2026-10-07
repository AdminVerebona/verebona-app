-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0278 : statuts d'un bien — liste officielle (lot 32, décision PO
-- du 07/10/2026, Q11 : « En service, Archived, Transmis, Vendu (pas besoin de
-- maintenance etc) »).
--
-- Avant : l'API acceptait EN_PANNE, EN_REPARATION, VENDU, DETRUIT, INACTIF,
-- que la contrainte 0121 refusait ; la base admettait EN_MAINTENANCE et
-- HORS_SERVICE, que l'interface ne proposait pas. Une vente proposée par
-- « À traiter » ne pouvait pas être enregistrée (VENDU refusé).
--
-- 1. Anciennes valeurs converties :
--      EN_MAINTENANCE, HORS_SERVICE, EN_PANNE, EN_REPARATION, INACTIF → EN_SERVICE
--      DETRUIT                                                        → ARCHIVED
--    (toute autre valeur inconnue → EN_SERVICE, pour que la contrainte passe).
-- 2. Contrainte `assets_status_check` = EN_SERVICE, VENDU, TRANSMIS, ARCHIVED
--    (même liste que `src/lib/asset-status.ts`, test PO-Q11). Posée NOT VALID
--    puis validée : la validation ne bloque pas les écritures concurrentes.
--
-- Les statuts des ÉQUIPEMENTS (`equipments.status`) ne sont pas concernés.
-- Idempotente : conversions ciblées et contrainte supprimée / recréée,
-- rejouables sans effet.
-- Retour arrière : recréer la contrainte de 0121 (les conversions ne sont pas
-- réversibles, et n'ont pas à l'être : aucune ancienne valeur n'était
-- affichée ni exploitée différemment d'« en service »).
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_status_check;

UPDATE assets
   SET status = 'EN_SERVICE', updated_at = NOW()
 WHERE status IN ('EN_MAINTENANCE', 'HORS_SERVICE', 'EN_PANNE', 'EN_REPARATION', 'INACTIF');

UPDATE assets
   SET status = 'ARCHIVED', archived_reason = COALESCE(archived_reason, 'user'), updated_at = NOW()
 WHERE status = 'DETRUIT';

UPDATE assets
   SET status = 'EN_SERVICE', updated_at = NOW()
 WHERE status IS NULL OR status NOT IN ('EN_SERVICE', 'VENDU', 'TRANSMIS', 'ARCHIVED');

ALTER TABLE assets
  ADD CONSTRAINT assets_status_check
    CHECK (status IN ('EN_SERVICE', 'VENDU', 'TRANSMIS', 'ARCHIVED')) NOT VALID;

ALTER TABLE assets VALIDATE CONSTRAINT assets_status_check;
