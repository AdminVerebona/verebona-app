-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0802 : registre des sessions (lot 92, CDC 18 §20, §31.4 ;
-- SESS-05..08, SEC-03 ; décision PO Q5 — recommandation).
--
-- Une ligne par session (famille `sid` des jetons, lot 37). Inscription à la
-- connexion, et pour les sessions ouvertes AVANT ce déploiement, à leur
-- prochain renouvellement (`registered_via = 'REFRESH'`) : personne n'est
-- déconnecté. Aucune donnée existante n'est modifiée.
--
--   device_key          : empreinte HMAC de l'identifiant first-party de
--                         l'appareil (cookie `vb_device` ou identifiant
--                         d'installation de l'application) — jamais en clair ;
--   client_type         : WEB | PWA | IOS | ANDROID (déclaratif, affichage) ;
--   device_label /
--   browser_label       : libellés dérivés du User-Agent (aucune IP, aucune
--                         localisation) ;
--   expires_at          : échéance d'inactivité (30 j, repoussée à chaque
--                         renouvellement) ;
--   revoked_at /
--   revocation_reason   : révocation unitaire, « autres appareils »,
--                         déconnexion, ou révocation globale reflétée ;
--   refresh_token_hash /
--   refresh_version     : empreinte (SHA-256) et rang du jeton de
--                         renouvellement courant — l'autorité de la rotation
--                         et du rejeu reste `revoked_tokens` (lot 37).
--
-- Pas de clé étrangère vers `users` (comme `revoked_tokens`) : la suppression
-- d'un compte purge `user_id` (contrôle des orphelins), la restauration d'une
-- sauvegarde conserve la table courante. Purge : tâche
-- `auth-rate-limits-purge` (lignes terminées depuis 90 jours).
-- Idempotente ; expand seulement.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_sessions (
  sid                TEXT        PRIMARY KEY,
  user_id            INTEGER     NOT NULL,
  device_key         TEXT,
  device_source      TEXT,
  client_type        TEXT        NOT NULL DEFAULT 'WEB',
  app_version        TEXT,
  device_label       TEXT        NOT NULL,
  browser_label      TEXT        NOT NULL,
  auth_method        TEXT,
  registered_via     TEXT        NOT NULL DEFAULT 'LOGIN',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  revocation_reason  TEXT,
  refresh_token_hash TEXT,
  refresh_version    INTEGER     NOT NULL DEFAULT 1,
  CONSTRAINT user_sessions_client_type_chk CHECK (client_type IN ('WEB', 'PWA', 'IOS', 'ANDROID'))
);
