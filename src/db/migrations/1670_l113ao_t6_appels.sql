-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1670 : T6 — appels FORMULATE évitables, attribution T6, réservation
-- durable des générations (lot 113AO, carte Trello #748 « T6 — Supprimer les
-- appels Gemini inutiles et fiabiliser l'attribution, l'idempotence et les
-- erreurs »).
--
--   · `t6_formulate_reservations` : une ligne par CLÉ DE GÉNÉRATION FORMULATE
--     réellement équivalente (compte + clé du cache T6 : sujets et faits,
--     langue, version effective du prompt maître et de la configuration,
--     contrats d'entrée et de sortie). Sert de RÉSERVATION DURABLE partagée par
--     toutes les instances (web, worker) : une seule génération fournisseur
--     par clé à la fois (bail `lease_until`, reprise à l'expiration après un
--     arrêt brutal, relecture du cache sous réservation), et de mesure :
--       status     RUNNING (génération en cours, bail) | DONE (cache écrit) |
--                  FAILED (échec, nouvel essai borné) | DETERMINISTIC (aucun
--                  appel : texte entièrement calculable par le serveur, servi
--                  tel quel — appel évité) ;
--       contended  demandes équivalentes refusées pendant le bail (doublons
--                  évités entre instances) ;
--       hits       affichages servis sans appel pour une clé DETERMINISTIC ;
--       source_codes / subjects : nature des sujets (codes de signal, jamais de
--                  texte ni de donnée du document).
--     Aucun contenu, aucun prompt, aucune donnée personnelle. Suppression du
--     compte : cascade. Purge : 30 jours (comme `home_mascot_cache`).
--   · `home_mascot_pregen_requests.trigger_execution_id` : exécution métier
--     qui a DEMANDÉ la pré-génération (fin d'une analyse T1 : `T1:job:…`),
--     conservée comme lien de causalité — jamais l'exécution des appels T6.
--
-- Additive, idempotente, rejouable ; aucune reprise de données ici (rattrapage
-- BO « T6 : rattachement des appels à leur exécution T6 », simulable et
-- restaurable). Retour arrière : DROP TABLE t6_formulate_reservations ; ALTER
-- TABLE home_mascot_pregen_requests DROP COLUMN trigger_execution_id (le code
-- ignore leur absence).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS t6_formulate_reservations (
  account_id    INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cache_key     TEXT         NOT NULL,
  status        TEXT         NOT NULL DEFAULT 'RUNNING',
  owner_id      UUID,
  lease_until   TIMESTAMPTZ,
  mode          TEXT,
  attempts      INTEGER      NOT NULL DEFAULT 0,
  contended     INTEGER      NOT NULL DEFAULT 0,
  hits          INTEGER      NOT NULL DEFAULT 0,
  source_codes  TEXT[],
  subjects      INTEGER,
  trace_id      TEXT,
  last_error    TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  PRIMARY KEY (account_id, cache_key)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 't6_formulate_reservations_status_check') THEN
    ALTER TABLE t6_formulate_reservations ADD CONSTRAINT t6_formulate_reservations_status_check
      CHECK (status IN ('RUNNING', 'DONE', 'FAILED', 'DETERMINISTIC'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS t6_formulate_reservations_created_idx ON t6_formulate_reservations (created_at);

COMMENT ON TABLE t6_formulate_reservations IS
  'Lot 113AO (#748) : réservation durable d''une génération T6 FORMULATE par clé de génération (bail, reprise, relecture du cache) et mesure des appels évités (texte déterministe) et des doublons refusés. Aucun contenu.';

DO $$
BEGIN
  IF to_regclass('home_mascot_pregen_requests') IS NOT NULL THEN
    ALTER TABLE home_mascot_pregen_requests ADD COLUMN IF NOT EXISTS trigger_execution_id TEXT;
    COMMENT ON COLUMN home_mascot_pregen_requests.trigger_execution_id IS
      'Lot 113AO (#748) : exécution métier qui a demandé la pré-génération (lien de causalité, ex. T1:job:…), jamais l''exécution des appels T6.';
  END IF;
END $$;
