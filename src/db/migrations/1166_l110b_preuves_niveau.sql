-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1166 : niveau des preuves de réauthentification (lot 110B,
-- ticket MFA §6). `assurance` = 2 pour une réauthentification par clé d'accès
-- ou application d'authentification, 1 sinon (mot de passe, Google, Apple).
-- Les preuves existantes (5 minutes au plus) valent 1. Additive, idempotente ;
-- colonne avec défaut constant (aucune réécriture de table).
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE reauth_proofs ADD COLUMN IF NOT EXISTS assurance SMALLINT NOT NULL DEFAULT 1;
