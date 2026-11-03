-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1005 : suggestions de l'accueil passées par l'utilisateur
-- (lot 106B, ticket « Mascotte — réparer les suggestions et ajouter des
-- invitations de découverte »). Service : `src/services/home/mascot/discovery.ts`
-- (`recordSuggestionSkip`, `readSuggestionSkips`), route
-- POST /api/home/mascot/suggestions/skip.
--
--   home_suggestion_skips — « Autre suggestion » : préférence PERSONNELLE
--       (Duo : chaque membre la sienne) d'une suggestion de l'accueil
--       (invitation de découverte `DISC:<univers>:<type>` ou question T6
--       `Q:T6:…`). Une suggestion passée n'est plus proposée pendant la
--       période de repos (`DISCOVERY_SKIP_REST_DAYS`). Jamais une tâche
--       « À traiter », une alerte ni un retard ; aucune donnée métier.
--       Unicité (compte, utilisateur, suggestion) : écriture par ON CONFLICT.
--       Purge bornée à l'écriture (au-delà du repos ou du plafond).
--
-- Table neuve (vide) : contraintes et index créés avec elle. Additive et
-- idempotente, rejouable. Suppression du compte ou de l'utilisateur : ON DELETE
-- CASCADE. Retour arrière : DROP TABLE IF EXISTS home_suggestion_skips (le code
-- tolère son absence : aucune suggestion passée retenue).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS home_suggestion_skips (
  id              BIGSERIAL   PRIMARY KEY,
  account_id      INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id         INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  suggestion_key  TEXT        NOT NULL,
  skipped_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT home_suggestion_skips_uq UNIQUE (account_id, user_id, suggestion_key),
  CONSTRAINT home_suggestion_skips_key_check CHECK (char_length(suggestion_key) BETWEEN 1 AND 200)
);

COMMENT ON TABLE home_suggestion_skips IS
  'Lot 106B : suggestions de l''accueil passées (« Autre suggestion ») par utilisateur — préférence personnelle, jamais une tâche « À traiter ».';
