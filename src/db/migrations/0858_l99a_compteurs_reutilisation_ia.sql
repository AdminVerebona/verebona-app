-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0858 : compteurs DISTINCTS d'usage de l'IA (lot 99A, ticket P1 T3,
-- point D).
--
-- Un appel réel au fournisseur reste tracé par `ai_usage_event` (coût, jetons).
-- Ce qui n'en est PAS un est compté ici, par jour, compte, traitement,
-- opération et nature (`kind`) :
--   · PROVIDER_CACHE_HIT   réponse servie par le cache temporaire (0 coût) ;
--   · CONCURRENT_SHARED    demande identique simultanée : réponse partagée ;
--   · CACHE_RENEWED        entrée expirée remplacée (après un appel réel) ;
--   · DECISION_REUSED      décision T3 mémorisée réutilisée sans appel ;
--   · DECISION_REEVALUATED contexte changé : décision réévaluée ;
--   · DECISION_FORCED      relance forcée tracée ;
--   · USER_ARBITRATION_KEPT arbitrage utilisateur déjà tranché : aucun appel.
--
-- Passages T3 : appels réels, réponses cache et décisions réutilisées en
-- colonnes distinctes (NULL = passage antérieur au lot 99A, non mesuré).
-- `ai_calls` garde son nom et compte désormais les seuls appels RÉELS.
--
-- Additive, idempotente. Retour arrière : DROP TABLE IF EXISTS
-- ai_reuse_counters (les colonnes ajoutées peuvent rester).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_reuse_counters (
  id             BIGSERIAL   PRIMARY KEY,
  day            DATE        NOT NULL,
  account_id     INTEGER     REFERENCES accounts(id) ON DELETE CASCADE,
  treatment      TEXT        NOT NULL DEFAULT '',
  operation_code TEXT        NOT NULL DEFAULT '',
  kind           TEXT        NOT NULL,
  count          INTEGER     NOT NULL DEFAULT 0,
  last_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_reuse_counters_kind_chk CHECK (kind IN (
    'PROVIDER_CACHE_HIT', 'CONCURRENT_SHARED', 'CACHE_RENEWED',
    'DECISION_REUSED', 'DECISION_REEVALUATED', 'DECISION_FORCED', 'USER_ARBITRATION_KEPT')),
  CONSTRAINT ai_reuse_counters_count_chk CHECK (count >= 0)
);

-- Table neuve : index d'agrégation créé ici (création instantanée).
CREATE UNIQUE INDEX IF NOT EXISTS ai_reuse_counters_key_uidx
  ON ai_reuse_counters (day, (COALESCE(account_id, 0)), treatment, operation_code, kind);

ALTER TABLE account_reconciliation_runs ADD COLUMN IF NOT EXISTS provider_calls   INTEGER;
ALTER TABLE account_reconciliation_runs ADD COLUMN IF NOT EXISTS ai_cache_hits    INTEGER;
ALTER TABLE account_reconciliation_runs ADD COLUMN IF NOT EXISTS decisions_reused INTEGER;

ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS provider_calls   INTEGER;
ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS ai_cache_hits    INTEGER;
ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS decisions_reused INTEGER;
