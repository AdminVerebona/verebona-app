-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0616 : état RÉEL et DURABLE des évaluations T6 EVALUATE (lot 78C —
-- ticket « [P1] T6 — Corriger les évaluations bloquées en PENDING et
-- fiabiliser leur exécution »).
--
-- Jusqu'ici, « PENDING » se DÉDUISAIT d'une décision absente : rien ne
-- prouvait qu'une évaluation était réellement en cours. Les échecs récents et
-- les exécutions en cours n'étaient connus qu'en MÉMOIRE de l'instance
-- (perdus au redémarrage, invisibles des autres instances) : une échéance
-- pouvait rester indéfiniment « en cours d'examen ».
--
--   t6_evaluation_runs — une ligne par échéance (état COURANT de son
--   évaluation, pas un historique : l'historique est dans les rapports
--   `evaluate:display` / `evaluate:pregen`) :
--     status               PENDING      demandée, en attente de prise en charge
--                          RUNNING      exécution prise (bail `lease_until`) ;
--                                       bail expiré = traitement INTERROMPU,
--                                       repris par le passage suivant
--                          RETRY_WAIT   échec, nouvel essai planifié (`next_attempt_at`)
--                          FAILED       tentatives épuisées : reprise explicite
--                                       (BO › Supervision) ou contexte modifié
--                          COMPLETED    décision valide ENREGISTRÉE
--                          UNAVAILABLE  traitement indisponible (plafond IA du
--                                       compte…), nouvel essai à `next_attempt_at`
--     context_fingerprint  empreinte (`v4:`) du contexte évalué ; une autre
--     evaluation_signature et configuration (`e2:`) : la demande repart de zéro
--     attempts             tentatives depuis la dernière demande
--     run_id / mode        exécution qui détient la ligne (clôture conditionnée
--                          par `run_id` : une instance dont le bail a expiré
--                          n'écrit plus) ; `display` ou `pregen`
--     requested_at, started_at, finished_at, lease_until, next_attempt_at
--     last_error_kind      model_unavailable, invalid_output, rejected,
--                          write_failed, interrupted, cost_cap
--     last_error / last_outcome / trace_id / interrupted_count
--     same_context_runs    nouvelles évaluations d'un contexte INCHANGÉ déjà
--                          évalué (décision enregistrée encore réclamée) dans
--                          la fenêtre anti-boucle : au plus 3, puis attente
--
-- Prise en charge sérialisée par compte (`pg_advisory_xact_lock`, espace
-- 78016) + verrou de ligne : jamais deux exécutions d'une même évaluation
-- entre instances. Aucune donnée personnelle (identifiants, codes, motifs).
-- Table nouvelle, index créés avec elle (vide) ; le code sonde sa présence :
-- table absente (fenêtre de déploiement) → comportement du lot 77.
-- Idempotente, rejouable.
-- Retour arrière : table ignorée par le code du lot 77 (DROP TABLE IF EXISTS
-- t6_evaluation_runs possible).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('agenda_items') IS NOT NULL AND to_regclass('accounts') IS NOT NULL THEN
    CREATE TABLE IF NOT EXISTS t6_evaluation_runs (
      agenda_item_id       INTEGER     PRIMARY KEY REFERENCES agenda_items(id) ON DELETE CASCADE,
      account_id           INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      status               TEXT        NOT NULL DEFAULT 'PENDING'
                           CHECK (status IN ('PENDING', 'RUNNING', 'RETRY_WAIT', 'FAILED', 'COMPLETED', 'UNAVAILABLE')),
      context_fingerprint  TEXT,
      evaluation_signature TEXT,
      attempts             INTEGER     NOT NULL DEFAULT 0,
      run_id               TEXT,
      mode                 TEXT,
      requested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at           TIMESTAMPTZ,
      finished_at          TIMESTAMPTZ,
      lease_until          TIMESTAMPTZ,
      next_attempt_at      TIMESTAMPTZ,
      last_error_kind      TEXT,
      last_error           TEXT,
      last_outcome         TEXT,
      trace_id             TEXT,
      interrupted_count    INTEGER     NOT NULL DEFAULT 0,
      same_context_runs    INTEGER     NOT NULL DEFAULT 0,
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS t6_evaluation_runs_account_idx ON t6_evaluation_runs (account_id, status);
    -- Supervision : évaluations non terminées ou en échec (balayage borné).
    CREATE INDEX IF NOT EXISTS t6_evaluation_runs_open_idx ON t6_evaluation_runs (status, requested_at)
      WHERE status <> 'COMPLETED';

    COMMENT ON TABLE t6_evaluation_runs IS
      'Lot 78C : état réel et durable de l''évaluation T6 EVALUATE de chaque échéance (PENDING, RUNNING, RETRY_WAIT, FAILED, COMPLETED, UNAVAILABLE), tentatives, erreurs, bail.';
  END IF;
END $$;
