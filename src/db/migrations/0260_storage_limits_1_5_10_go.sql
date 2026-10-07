-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0260 : plafonds d'espace de stockage par offre (lot 26).
--
-- Décision produit : Standard 1 Go · Premium 5 Go · Premium Duo 10 Go
-- (auparavant 2 / 10 / 15 Go, migration 0170). 1 Go = 1024³ octets.
--
-- Même valeurs que le référentiel du code (`SUBSCRIPTION_LIMITS.*.maxStorageGb`,
-- `src/lib/subscription-limits.ts`), dont dérive le repli de
-- `src/lib/storage-quota.ts`.
--
-- IDEMPOTENTE ET PRUDENTE : seules les lignes encore à l'ancienne valeur par
-- défaut (ou sans valeur) sont modifiées. Rejouer la migration est sans effet ;
-- une valeur réglée autrement par l'administration n'est pas écrasée.
--
-- Effet : à 100 %, seuls les NOUVEAUX dépôts sont refusés (STO-003) ; aucun
-- fichier existant n'est supprimé ni rendu inaccessible.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS max_storage_bytes BIGINT;

UPDATE plan_limits SET max_storage_bytes = 1::bigint * 1024 * 1024 * 1024
 WHERE plan_code = 'standard'
   AND (max_storage_bytes IS NULL OR max_storage_bytes = 2::bigint * 1024 * 1024 * 1024);

UPDATE plan_limits SET max_storage_bytes = 5::bigint * 1024 * 1024 * 1024
 WHERE plan_code = 'premium'
   AND (max_storage_bytes IS NULL OR max_storage_bytes = 10::bigint * 1024 * 1024 * 1024);

UPDATE plan_limits SET max_storage_bytes = 10::bigint * 1024 * 1024 * 1024
 WHERE plan_code = 'premium_duo'
   AND (max_storage_bytes IS NULL OR max_storage_bytes = 15::bigint * 1024 * 1024 * 1024);
