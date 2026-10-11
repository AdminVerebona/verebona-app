-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0313 : limiteur de tentatives d'authentification PARTAGÉ entre
-- instances (lot 37, CDC 18 §32-§33, faille C4).
--
-- Une ligne par clé `<parcours>:<ip|acct>:<HMAC>` — connexion, mot de passe
-- oublié, renvoi de vérification, réinitialisation. Les valeurs (adresse
-- e-mail, IP) n'y figurent JAMAIS en clair : seule une empreinte HMAC.
--
--   attempts / window_started_at : tentatives comptées dans la fenêtre ;
--   locked_until                 : verrou en cours (NULL : aucun) ;
--   lock_level / last_locked_at  : récidive (verrouillage progressif
--                                  15 → 30 → 60 min, oubliée après 24 h).
--
-- Purge : tâche interne `auth-rate-limits-purge` (lignes inactives depuis
-- 48 h et sans verrou en cours). Idempotente ; expand seulement.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket_key        TEXT        PRIMARY KEY,
  attempts          INTEGER     NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until      TIMESTAMPTZ,
  lock_level        INTEGER     NOT NULL DEFAULT 0,
  last_locked_at    TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
