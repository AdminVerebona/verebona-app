-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0621 : récapitulatif quotidien « À traiter » — jamais renvoyé à
-- contenu inchangé (lot 79C).
--
--   to_process_digest_state — une ligne par compte × destinataire : le
--   CONTENU du dernier récapitulatif émis (`item_keys` : identifiants publics
--   des actions × cycle), son total et sa date. Un nouveau récapitulatif n'est
--   émis que si au moins une action n'y figurait pas (nouveauté réelle) : une
--   simple variation du compteur (actions résolues) n'en est pas une, et une
--   action résolue puis remplacée par une autre l'est, même à total égal.
--
-- Aucune donnée personnelle hors identifiants techniques ; supprimée avec le
-- compte ou l'utilisateur (ON DELETE CASCADE). Pas de bien ni de fichier :
-- hors classement des transferts de biens.
--
-- Idempotente : rejouable sans effet.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS to_process_digest_state (
  account_id       INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id          INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_keys        TEXT[]      NOT NULL DEFAULT '{}',
  total            INTEGER     NOT NULL DEFAULT 0,
  last_emitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);
