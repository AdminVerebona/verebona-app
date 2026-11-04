-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1085 : suggestions partagées CONSULTÉES (lot 108J, ticket
-- « Suggestions de l'accueil et de T2 — source unique, trois objectifs »).
-- Service : `src/services/suggestions/shared/consultations.ts`.
--
--   shared_suggestion_consultations — une suggestion de l'accueil ou de
--       « Demander à Verebona » cliquée par l'utilisateur (Duo : chaque membre
--       la sienne). Sert UNIQUEMENT à la rotation : la suggestion consultée
--       laisse sa place à une autre déjà disponible et ne revient pas tout de
--       suite ; elle peut revenir plus tard (repos court,
--       `SHARED_SUGGESTION_CONSULTED_REST_HOURS`). Une consultation n'est
--       jamais une action métier, une preuve de maîtrise, une tâche
--       « À traiter », une alerte ni un retard ; aucune donnée métier.
--       Unicité (compte, utilisateur, suggestion) : écriture par ON CONFLICT ;
--       purge bornée à l'écriture.
--
-- Remplace, pour les suggestions, la table `home_suggestion_skips` (1005,
-- « Autre suggestion » supprimé) : celle-ci n'est plus lue ni écrite, ses
-- lignes sont conservées (aucune destruction de donnée).
--
-- Table neuve (vide) : contraintes et index créés avec elle. Additive et
-- idempotente, rejouable. Suppression du compte ou de l'utilisateur : ON DELETE
-- CASCADE. Retour arrière : DROP TABLE IF EXISTS shared_suggestion_consultations
-- (le code tolère son absence : aucune consultation retenue).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS shared_suggestion_consultations (
  id               BIGSERIAL   PRIMARY KEY,
  account_id       INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id          INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  suggestion_id    TEXT        NOT NULL,
  consulted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  consult_count    INTEGER     NOT NULL DEFAULT 1,
  CONSTRAINT shared_suggestion_consultations_uq UNIQUE (account_id, user_id, suggestion_id),
  CONSTRAINT shared_suggestion_consultations_id_check CHECK (char_length(suggestion_id) BETWEEN 1 AND 80)
);

COMMENT ON TABLE shared_suggestion_consultations IS
  'Lot 108J : suggestions partagées (accueil et « Demander à Verebona ») consultées par utilisateur — rotation seulement, jamais une action métier ni une tâche « À traiter ».';
