-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0840 : ticket d'ouverture dans le navigateur système pour associer
-- ou confirmer Google / Apple DEPUIS L'APPLICATION (lot 97B — PO M1 ; CDC 18
-- §12.3, §18.2, §21.3).
--
-- `auth_transactions.app_ticket_hash` : empreinte SHA-256 d'un ticket à usage
-- unique (10 min, durée de la transaction). La vue de l'application (session
-- + réauthentification 5 min) crée la transaction « link » / « reauth » ; le
-- navigateur système présente le ticket à `GET /api/auth/oauth/app/continue`
-- qui le consomme, pose la liaison au navigateur (cookie `vb_oauth`) et
-- redirige vers le fournisseur. Le ticket n'est jamais stocké en clair.
--
-- Additive et idempotente (colonne nullable, aucune donnée modifiée). Table
-- classée SÉCURITÉ (jamais exportée). Retour arrière : colonne ignorée par
-- l'ancien code (ALTER TABLE … DROP COLUMN IF EXISTS app_ticket_hash possible).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE auth_transactions ADD COLUMN IF NOT EXISTS app_ticket_hash TEXT;
