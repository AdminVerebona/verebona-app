-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0856 : mémoire DURABLE des décisions T3 assistées par l'IA
-- (lot 99A, ticket P1 « T3 — Supprimer les appels IA redondants »).
--
-- Une ligne par (compte, objet, champ) et par CONTEXTE (empreinte) : décision
-- rendue par l'arbitrage IA `t3_value_conflict` — valeur retenue, abstention
-- ou conflit non résolu, échec IA (avec date de nouvelle tentative). Consultée
-- AVANT tout appel modèle : à empreinte identique, la décision est réutilisée
-- sans appel (compteur `reuse_count`, `last_reused_at`). Une empreinte
-- différente (preuve, valeur, résolution utilisateur, règle, configuration IA)
-- ou une relance forcée tracée remplace l'entrée ACTIVE : l'ancienne passe
-- SUPERSEDED avec son motif (traçabilité des invalidations).
--
-- Distincte du cache TEMPORAIRE des réponses modèle (`ai_operation_idempotency`)
-- : la mémoire métier ne s'expire pas, le cache si.
--
-- `fingerprint_parts` : empreintes par composante (aucune valeur en clair,
-- aucun extrait de document) — sert à dire POURQUOI une réévaluation a eu lieu.
-- `decision` : décision traduite par le moteur (action, valeur proposée,
-- preuves citées, confiance, motif) — mêmes données que `reconciliation_decisions`.
--
-- Additive, idempotente, aucune reprise de données. Suit le bien lors d'un
-- changement de compte (asset-account-transfer). Index de suppression du bien :
-- 0856_..._idx_1.
-- Retour arrière : T3_DECISION_MEMORY_ENABLED=0 (le moteur rappelle l'IA comme
-- avant), puis éventuellement DROP TABLE IF EXISTS t3_decision_memory.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS t3_decision_memory (
  id                  BIGSERIAL   PRIMARY KEY,
  account_id          INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id            INTEGER     NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  object_type         TEXT        NOT NULL DEFAULT 'ASSET',
  object_id           INTEGER     NOT NULL,
  field_key           TEXT        NOT NULL,
  fingerprint         TEXT        NOT NULL,
  fingerprint_parts   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  operation_code      TEXT        NOT NULL,
  ai_config_signature TEXT        NOT NULL DEFAULT '',
  outcome             TEXT        NOT NULL,
  decision            JSONB       NOT NULL,
  ai_source           TEXT        NOT NULL,
  ai_trace_id         TEXT,
  forced              BOOLEAN     NOT NULL DEFAULT false,
  forced_reason       TEXT,
  status              TEXT        NOT NULL DEFAULT 'ACTIVE',
  reuse_count         INTEGER     NOT NULL DEFAULT 0,
  last_reused_at      TIMESTAMPTZ,
  retry_after         TIMESTAMPTZ,
  superseded_at       TIMESTAMPTZ,
  superseded_reason   TEXT,
  superseded_by       BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT t3_decision_memory_object_type_chk CHECK (object_type IN ('ASSET', 'EQUIPMENT', 'ROOM')),
  CONSTRAINT t3_decision_memory_outcome_chk CHECK (outcome IN ('APPLY', 'UPDATE', 'CONFLICT', 'ABSTAIN', 'KEEP', 'AI_FAILED')),
  CONSTRAINT t3_decision_memory_source_chk CHECK (ai_source IN ('PROVIDER', 'CACHE', 'UNAVAILABLE')),
  CONSTRAINT t3_decision_memory_status_chk CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
  CONSTRAINT t3_decision_memory_counts_chk CHECK (reuse_count >= 0),
  CONSTRAINT t3_decision_memory_parts_chk CHECK (jsonb_typeof(fingerprint_parts) = 'object')
);

-- Une seule décision ACTIVE par champ d'objet (table neuve : création instantanée).
CREATE UNIQUE INDEX IF NOT EXISTS t3_decision_memory_active_uidx
  ON t3_decision_memory (account_id, object_type, object_id, field_key) WHERE status = 'ACTIVE';
