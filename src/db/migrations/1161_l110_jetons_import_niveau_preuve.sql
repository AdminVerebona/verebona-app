-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1161 : niveau de preuve de la session qui a émis un jeton d'import
-- du partage natif (intégration lot 110 : 110A × 110B).
--
-- Un jeton d'import vit jusqu'à 72 h. Émis par une session de niveau 1 (avant
-- l'obligation MFA, ou avant l'enrôlement), il ne doit pas continuer à déposer
-- des documents une fois la double authentification exigée pour son titulaire :
-- la vérification du jeton refuse alors (MFA_REQUIRED) un jeton de niveau 1.
-- Additive, idempotente. Jetons existants : NULL = niveau 1 (fail closed).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE mobile_share_import_grants ADD COLUMN IF NOT EXISTS session_aal SMALLINT;
