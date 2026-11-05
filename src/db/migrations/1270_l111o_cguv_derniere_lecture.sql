-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1270 : détail de la dernière lecture du manifeste public des CGUV
-- (lot 111O, P0 « inscription bloquée — CGUV en cours de publication »).
-- Service : `src/services/legal/cguv-referential.service.ts` (écriture),
-- `src/services/legal/cguv-publication-diagnostic.ts` (BO › Exploitation ›
-- Santé › carte « CGUV publiées »).
--
--   legal_manifest_sync_state.last_read — JSONB : adresse lue, statut HTTP,
--       motif stable de l'échec (MANIFEST_HTTP_UNAUTHORIZED, …_ORIGIN_MISMATCH,
--       …_REDIRECT_FOREIGN…), versions publiées lues, version désignée « en
--       vigueur » par le site, version en vigueur de l'application, empreinte
--       vérifiée ou non. Aucune donnée personnelle, aucun secret.
--
-- Additive, idempotente, rejouable. Retour arrière : ALTER TABLE
-- legal_manifest_sync_state DROP COLUMN IF EXISTS last_read (la carte BO
-- affiche alors seulement les colonnes existantes).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE legal_manifest_sync_state ADD COLUMN IF NOT EXISTS last_read JSONB;
