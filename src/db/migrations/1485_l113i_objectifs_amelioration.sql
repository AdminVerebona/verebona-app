-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1485 : objectifs d'amélioration automatique IA (lot 113I, CDC V2
-- §4.1, §27, SQL-001, LIF-004/009). Service :
-- `src/services/ai/qualification/improvement-objectives.ts`.
--
-- Justification (SQL-001) : l'OBJECTIF (problème ou opportunité constatés,
-- dédupliqué par événement et référence du traitement, file FIFO, variantes
-- bornées) n'existe dans aucune table existante (vérifié : 0724, 0725, 0985 ne
-- portent que campagnes, preuves, candidates et journal). Il RÉFÉRENCE les
-- campagnes existantes (`ai_qualification_campaigns.objective_id`) ; le statut
-- de campagne n'est PAS dupliqué (LIF-004).
--
-- Unicité des objectifs OUVERTS (environnement, traitement, empreinte
-- d'événement, empreinte de référence) : index unique partiel `WHERE is_open`
-- (LIF-009, DATA-04). Table technique sans compte (aucune colonne account_id).
-- Additive, idempotente. Retour arrière : DROP TABLE ai_improvement_objectives ;
-- ALTER TABLE ai_qualification_campaigns DROP COLUMN objective_id (colonne
-- nullable ignorée par le code antérieur).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_improvement_objectives (
  id                    BIGSERIAL    PRIMARY KEY,
  environment           TEXT         NOT NULL,
  treatment             TEXT         NOT NULL,
  kind                  TEXT         NOT NULL,
  source_ref            TEXT         NOT NULL DEFAULT '',
  event_fingerprint     TEXT         NOT NULL,
  baseline_fingerprint  TEXT         NOT NULL,
  priority              TEXT         NOT NULL DEFAULT 'FIFO',
  status                TEXT         NOT NULL DEFAULT 'QUEUED',
  is_open               BOOLEAN      NOT NULL DEFAULT TRUE,
  variant_count         INTEGER      NOT NULL DEFAULT 0,
  next_eligible_month   TEXT,
  reason                TEXT,
  detail                JSONB        NOT NULL DEFAULT '{}'::jsonb,
  admin_override        JSONB,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  resolved_at           TIMESTAMPTZ,
  CONSTRAINT ai_improvement_objectives_treatment_chk CHECK (treatment IN ('T1', 'T2', 'T3', 'T4', 'T6')),
  CONSTRAINT ai_improvement_objectives_kind_chk CHECK (kind IN ('PROVEN_DEFECT', 'STABLE_MODEL_AVAILABLE', 'PROVIDER_DEPRECATION', 'CERTIFIED_CORPUS_CHANGE', 'COST_OPPORTUNITY', 'NEW_RELEVANT_EVIDENCE')),
  CONSTRAINT ai_improvement_objectives_priority_chk CHECK (priority IN ('FIFO', 'RETIREMENT')),
  CONSTRAINT ai_improvement_objectives_status_chk CHECK (status IN ('DETECTED', 'SCREENING', 'ELIGIBLE', 'QUEUED', 'WAITING_BUDGET', 'WAITING_PREREQUISITE',
    'EXPERIMENTING', 'QUALIFYING', 'BLOCKED', 'COMPLETED_WITH_PROMOTION', 'COMPLETED_NO_GAIN', 'INCONCLUSIVE', 'ABANDONED', 'SUPERSEDED')),
  CONSTRAINT ai_improvement_objectives_variants_chk CHECK (variant_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_improvement_objectives_open_uidx
  ON ai_improvement_objectives (environment, treatment, event_fingerprint, baseline_fingerprint) WHERE is_open;
CREATE INDEX IF NOT EXISTS ai_improvement_objectives_queue_idx ON ai_improvement_objectives (environment, is_open, priority, created_at, id);
COMMENT ON TABLE ai_improvement_objectives IS
  'Lot 113I : objectifs d''amélioration automatique IA (préproduction) — dédupliqués par événement et référence du traitement, file FIFO (exception : retrait officiel d''un modèle), variantes bornées. Référence les campagnes existantes ; ne remplace pas leur statut.';

ALTER TABLE ai_qualification_campaigns ADD COLUMN IF NOT EXISTS objective_id BIGINT;
CREATE INDEX IF NOT EXISTS ai_qualification_campaigns_objective_idx ON ai_qualification_campaigns (objective_id) WHERE objective_id IS NOT NULL;
COMMENT ON COLUMN ai_qualification_campaigns.objective_id IS
  'Lot 113I : objectif d''amélioration servi par la campagne (nul : campagne manuelle, historique ou de conformité).';
