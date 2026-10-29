-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0803 : preuves de réauthentification (lot 92, CDC 18 §18.4,
-- §31.5 ; REAUTH-01/02/06/07 ; décision PO Q7 — recommandation).
--
-- Une preuve est émise par le SERVEUR après une réauthentification réussie
-- (mot de passe aujourd'hui ; Google / Apple, 2FA ensuite). Elle est liée à
-- l'utilisateur ET à la session (`sid`), vaut 5 minutes, est réutilisable
-- dans le bloc Sécurité et consommée par les actions à risque maximal
-- (`consumed_at`). Aucun secret : le client ne détient rien de plus que sa
-- session. Une seule preuve par session (la nouvelle remplace l'ancienne).
--
-- Pas de clé étrangère (comme `user_sessions`) : purge avec le compte
-- (contrôle des orphelins), table conservée à la restauration. Purge : tâche
-- `auth-rate-limits-purge`. Idempotente ; expand seulement.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reauth_proofs (
  id           TEXT        PRIMARY KEY,
  user_id      INTEGER     NOT NULL,
  sid          TEXT        NOT NULL,
  method       TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  consumed_for TEXT
);
