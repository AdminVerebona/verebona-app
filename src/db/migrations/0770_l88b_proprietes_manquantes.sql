-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0770 : propriétés métier manquantes reconstruites à partir de
-- l'ensemble des preuves (lot 88B, ticket P1 « Contrôle de cohérence —
-- Détecter et réparer les propriétés métier manquantes »).
--
-- `property_recovery_runs` : une ligne par ANALYSE T3 d'un objet (bien,
-- équipement) pour un lot de propriétés vides et un contexte transversal
-- donné (empreinte du contexte, version du prompt T3, empreinte du lot) —
-- issue (ANSWERED, NO_EVIDENCE, AI_FAILED, BUDGET_EXHAUSTED), appels IA et
-- leurs traces, résumé BORNÉ du contexte (couches, documents, troncature).
-- Rôle : anti-rappel (contexte inchangé → aucun nouvel appel), budget
-- partagé `T3_KNOWLEDGE_QUERY_DAILY_MAX`, audit.
--
-- `property_recovery_decisions` : une ligne par propriété et par contexte :
-- décision (WRITTEN par le writer canonique, ou ABSTAINED avec sa cause),
-- valeur avant / après, valeur proposée, constats validés (valeur écrite,
-- preuves citées, extrait, confiance, sens), refus de validation, preuves
-- `field_evidence` créées ou conservées, provenance (documents, Opérations,
-- composantes, Agenda) et traitement (opération, version du prompt, traces).
-- Jamais de contenu de document au-delà des extraits cités et validés.
--
-- Additive, idempotente, aucune reprise de données. Les deux tables suivent
-- le bien lors d'un changement de compte (asset-account-transfer :
-- `asset_id` = bien porteur). Index uniques créés ici (tables neuves :
-- création instantanée) ; index de budget : 0770_..._idx_1.
-- Retour arrière : DROP TABLE IF EXISTS property_recovery_decisions,
-- property_recovery_runs (les valeurs écrites restent tracées par le journal
-- 0216 `canonical_field_writes`, source `coherence_missing_property`).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS property_recovery_runs (
  id               BIGSERIAL   PRIMARY KEY,
  account_id       INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id         INTEGER     NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  object_type      TEXT        NOT NULL,
  object_id        INTEGER     NOT NULL,
  context_fp       TEXT        NOT NULL,
  prompt_version   TEXT        NOT NULL DEFAULT '',
  contract_version TEXT        NOT NULL,
  batch_fp         TEXT        NOT NULL,
  properties       TEXT[]      NOT NULL DEFAULT '{}',
  status           TEXT        NOT NULL,
  pages_total      INTEGER     NOT NULL DEFAULT 0,
  pages_examined   INTEGER     NOT NULL DEFAULT 0,
  calls            INTEGER     NOT NULL DEFAULT 0,
  attempts         INTEGER     NOT NULL DEFAULT 1,
  ai_trace_ids     TEXT[]      NOT NULL DEFAULT '{}',
  context_summary  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  error            TEXT,
  retry_at         TIMESTAMPTZ,
  trigger_code     TEXT,
  run_ref          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT property_recovery_runs_object_type_chk CHECK (object_type IN ('ASSET', 'EQUIPMENT')),
  CONSTRAINT property_recovery_runs_status_chk CHECK (status IN ('ANSWERED', 'NO_EVIDENCE', 'AI_FAILED', 'BUDGET_EXHAUSTED')),
  CONSTRAINT property_recovery_runs_counts_chk CHECK (calls >= 0 AND attempts >= 0 AND pages_total >= 0 AND pages_examined >= 0),
  CONSTRAINT property_recovery_runs_summary_chk CHECK (jsonb_typeof(context_summary) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS property_recovery_runs_entry_uidx
  ON property_recovery_runs (account_id, object_type, object_id, context_fp, prompt_version, batch_fp);

CREATE TABLE IF NOT EXISTS property_recovery_decisions (
  id               BIGSERIAL   PRIMARY KEY,
  run_id           BIGINT      NOT NULL REFERENCES property_recovery_runs(id) ON DELETE CASCADE,
  account_id       INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id         INTEGER     NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  object_type      TEXT        NOT NULL,
  object_id        INTEGER     NOT NULL,
  field_key        TEXT        NOT NULL,
  question_fp      TEXT        NOT NULL,
  context_fp       TEXT        NOT NULL,
  prompt_version   TEXT        NOT NULL DEFAULT '',
  decision         TEXT        NOT NULL,
  cause            TEXT,
  value_before     JSONB,
  value_after      JSONB,
  proposed_value   JSONB,
  findings         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  rejected         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  evidence_ids     INTEGER[]   NOT NULL DEFAULT '{}',
  provenance       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  write_outcome    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT property_recovery_decisions_object_type_chk CHECK (object_type IN ('ASSET', 'EQUIPMENT')),
  CONSTRAINT property_recovery_decisions_decision_chk CHECK (decision IN ('WRITTEN', 'ABSTAINED')),
  CONSTRAINT property_recovery_decisions_cause_chk CHECK ((decision = 'WRITTEN') = (cause IS NULL)),
  CONSTRAINT property_recovery_decisions_json_chk CHECK (jsonb_typeof(findings) = 'array' AND jsonb_typeof(rejected) = 'array' AND jsonb_typeof(provenance) = 'object')
);

-- Une décision par propriété et par contexte (table neuve : création instantanée, hors CONCURRENTLY).
CREATE UNIQUE INDEX IF NOT EXISTS property_recovery_decisions_entry_uidx
  ON property_recovery_decisions (account_id, object_type, object_id, field_key, context_fp, prompt_version, question_fp);

COMMENT ON TABLE property_recovery_runs IS
  'Lot 88B : analyses T3 (KNOWLEDGE_QUERY v2) des propriétés canoniques vides d''un objet — contexte (empreinte, résumé borné), issue, appels IA ; anti-rappel et budget.';
COMMENT ON TABLE property_recovery_decisions IS
  'Lot 88B : décision par propriété manquante (WRITTEN par le writer canonique / ABSTAINED avec cause) — avant / après, preuves, provenance, traitement.';
