-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1185 : statut de revue des « Questions sans réponse » (lot 110E,
-- ticket « T2 : réponses issues des Ressources »). Service :
-- `src/services/verebona-assistant/core/unanswered-journal.ts`.
--
--   t2_unanswered_reviews — UNE ligne par GROUPE de questions proches (clé =
--       empreinte de la formulation expurgée et normalisée, jamais le texte) :
--       statut À analyser / À corriger / Résolu, courte note d'administration
--       expurgée, administrateur et date de la dernière décision.
--
-- Pas de journal concurrent : les OCCURRENCES sont lues dans les traces T2
-- existantes (`verebona_request_runs.retrieval_methods_json`, bloc
-- `resources` ajouté au lot 110E) ; cette table ne garde que la décision de
-- revue. Table transversale sans account_id (aucune donnée de compte) : rien
-- à brancher sur la suppression de compte. Purge : même durée que
-- l'historique de l'assistant (`purge-assistant-logs.job.ts`).
-- Additive, idempotente, rejouable. Retour arrière : DROP TABLE IF EXISTS
-- t2_unanswered_reviews (le BO affiche alors « À analyser » partout).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS t2_unanswered_reviews (
  group_key   TEXT        PRIMARY KEY,
  status      TEXT        NOT NULL DEFAULT 'TO_ANALYZE',
  note        TEXT,
  updated_by  INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT t2_unanswered_reviews_key_check CHECK (group_key ~ '^[0-9a-f]{24}$'),
  CONSTRAINT t2_unanswered_reviews_status_check CHECK (status IN ('TO_ANALYZE', 'TO_FIX', 'RESOLVED')),
  CONSTRAINT t2_unanswered_reviews_note_check CHECK (note IS NULL OR char_length(note) <= 500)
);

CREATE INDEX IF NOT EXISTS t2_unanswered_reviews_updated_idx ON t2_unanswered_reviews (updated_at);

COMMENT ON TABLE t2_unanswered_reviews IS
  'Lot 110E : statut de revue des groupes de « Questions sans réponse » (clé = empreinte de la formulation expurgée) — occurrences lues dans verebona_request_runs.';
