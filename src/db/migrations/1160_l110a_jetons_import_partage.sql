-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1160 : jetons d'import du partage natif (lot 110A, ticket
-- « Partage natif iOS / Android : trois choix », décision PO du 04/11/2026).
-- Service : `src/services/mobile/share-import/grants.ts`.
--
--   mobile_share_import_grants — un « jeton de dépôt partagé » par session
--       mobile : remis par l'application ouverte (session vérifiée par la garde
--       de session habituelle) à sa partie native (Keychain du groupe d'apps
--       iOS / stockage privé chiffré Android), pour que l'extension de partage
--       iOS ou le service d'envoi Android importent un document SANS ouvrir
--       l'application. Portée réduite : IMPORT SEUL (aucune lecture), un
--       utilisateur et UN espace (compte), durée courte (72 h par défaut),
--       nombre d'usages borné, révocable, refusé dès que la session d'origine
--       est révoquée. Seule l'EMPREINTE SHA-256 du jeton est stockée.
--
-- Suppression de compte / d'utilisateur : ON DELETE CASCADE. Aucune donnée de
-- document (asset_id / file_id) : pas de transfert de bien concerné.
-- Additive, idempotente, rejouable. Retour arrière : DROP TABLE IF EXISTS
-- mobile_share_import_grants (le partage natif répond alors « En attente de
-- connexion » et l'import se termine à l'ouverture de l'application).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS mobile_share_import_grants (
  id              BIGSERIAL   PRIMARY KEY,
  token_hash      TEXT        NOT NULL,
  user_id         INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id      INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_sid     TEXT,
  platform        TEXT        NOT NULL,
  installation_id TEXT,
  max_uses        INTEGER     NOT NULL,
  uses            INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT,
  CONSTRAINT mobile_share_import_grants_token_uq UNIQUE (token_hash),
  CONSTRAINT mobile_share_import_grants_platform_check CHECK (platform IN ('ios', 'android')),
  CONSTRAINT mobile_share_import_grants_uses_check CHECK (uses >= 0 AND max_uses > 0),
  CONSTRAINT mobile_share_import_grants_hash_check CHECK (char_length(token_hash) = 64)
);

COMMENT ON TABLE mobile_share_import_grants IS
  'Lot 110A : jetons d''import du partage natif (empreinte seule) — import seul, un espace, courte durée, usages bornés, révocables.';
