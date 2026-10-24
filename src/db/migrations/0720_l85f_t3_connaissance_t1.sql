-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0720 : T3 exploite toute la connaissance T1 persistée avant de
-- conclure qu'une information manque (lot 85F, ticket P1 ; §5, §7, §8, §11,
-- §12).
--
-- `t3_knowledge_queries` : MÉMOIRE des interprétations sémantiques T3
-- (branche KNOWLEDGE_QUERY du prompt maître T3) d'une donnée documentaire —
-- une ligne par (document, donnée, empreinte de la question, empreinte du
-- contexte T1 transmis, version du prompt). Elle porte l'issue validée par le
-- serveur, les constats retenus (valeur écrite, preuves citées, extrait,
-- sens métier) et refusés (motif), les références des appels IA, le résumé
-- du contexte (couches, documents, bornes). Rôle :
--   · anti-rappel : une entrée inchangée n'est jamais resoumise au modèle ;
--   · budget : appels du compte sur 24 h (`T3_KNOWLEDGE_QUERY_DAILY_MAX`) ;
--   · contrôle COH-T1-KNOWLEDGE-CONSUMPTION : connaissance interprétée,
--     constats non exploités, unités partiellement structurées.
-- Une interprétation n'est JAMAIS une écriture : les valeurs passent par le
-- moteur de décision « À traiter » existant (propositions, calcul).
--
-- Additive, idempotente, aucune reprise de données. Suit le document lors
-- du transfert d'un bien (asset-account-transfer). Index unique créé ici
-- (table neuve : création instantanée) ; index de budget : 0720_..._idx_1.
-- Retour arrière : DROP TABLE IF EXISTS t3_knowledge_queries.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS t3_knowledge_queries (
  id               BIGSERIAL   PRIMARY KEY,
  account_id       INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id          INTEGER     NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  field_key        TEXT        NOT NULL,
  rule_code        TEXT,
  question_fp      TEXT        NOT NULL,
  context_fp       TEXT        NOT NULL,
  prompt_version   TEXT        NOT NULL DEFAULT '',
  status           TEXT        NOT NULL,
  outcome          TEXT,
  pages_total      INTEGER     NOT NULL DEFAULT 0,
  pages_examined   INTEGER     NOT NULL DEFAULT 0,
  calls            INTEGER     NOT NULL DEFAULT 0,
  attempts         INTEGER     NOT NULL DEFAULT 1,
  ai_trace_ids     TEXT[]      NOT NULL DEFAULT '{}',
  findings         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  rejected         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  context_summary  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  error            TEXT,
  retry_at         TIMESTAMPTZ,
  trigger_code     TEXT,
  run_ref          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT t3_knowledge_queries_status_chk CHECK (status IN ('ANSWERED', 'AI_FAILED')),
  CONSTRAINT t3_knowledge_queries_outcome_chk CHECK (outcome IS NULL OR outcome IN ('FOUND', 'CONSTITUENTS', 'CONTRADICTION', 'AMBIGUOUS', 'NOT_FOUND', 'REJECTED', 'INCOMPLETE')),
  CONSTRAINT t3_knowledge_queries_calls_chk CHECK (calls >= 0 AND attempts >= 0 AND pages_total >= 0 AND pages_examined >= 0),
  CONSTRAINT t3_knowledge_queries_findings_chk CHECK (jsonb_typeof(findings) = 'array' AND jsonb_typeof(rejected) = 'array'),
  CONSTRAINT t3_knowledge_queries_summary_chk CHECK (jsonb_typeof(context_summary) = 'object')
);

-- Une interprétation par entrée (table neuve : création instantanée, hors CONCURRENTLY).
CREATE UNIQUE INDEX IF NOT EXISTS t3_knowledge_queries_entry_uidx
  ON t3_knowledge_queries (account_id, file_id, field_key, question_fp, context_fp, prompt_version);

COMMENT ON TABLE t3_knowledge_queries IS
  'Lot 85F : mémoire des interprétations sémantiques T3 de la connaissance T1 persistée (KNOWLEDGE_QUERY) — issue validée, constats, preuves, appels ; jamais une écriture métier.';
