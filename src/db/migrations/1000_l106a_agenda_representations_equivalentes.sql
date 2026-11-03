-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1000 : représentations ÉQUIVALENTES d'un même fait dans l'Agenda
-- (lot 106A, ticket P1 « Agenda — doublons DPE non autoréparés », cas Maison /
-- 22/12/2020 : « Contrôle réalisé — Maison », « DPE réalisé — DPE », « DPE
-- réalisé — Maison »).
--
--   1. agenda_intervention_consolidations (journal 0591, lot 76H) : origine
--      `COHERENCE` admise. Une absorption décidée par le contrôle de cohérence
--      COH-AGENDA-EQUIVALENT-REPRESENTATIONS (identité CERTAINE : même bien,
--      même nature canonique, même date, référence stable identique — n° ADEME
--      —, preuves) utilise le MÊME journal que les consolidations 76H / 87B :
--      image complète de l'élément absorbé, liens et preuves déplacés,
--      restauration ligne à ligne, et mémoire anti-recréation de T4
--      (`absorbedOccurrenceKeeper`, clé fonctionnelle de l'élément absorbé).
--      `operation_id` reste NULL hors Opération. Contrainte ÉLARGIE (aucune
--      valeur existante invalidée) : NOT VALID puis VALIDATE.
--   2. agenda_equivalence_decisions : JOURNAL et FILE DURABLE des décisions
--      d'équivalence par bien et par groupe (bien | nature | type | date) :
--      verdict (CONSOLIDATED, DISTINCT, PROTECTED, UNCERTAIN, T4_PENDING,
--      T4_UNAVAILABLE, T4_SAME, T4_DISTINCT, FAILED), élément canonique,
--      éléments absorbés (remappage historisé ancien → canonique), clés
--      fonctionnelles absorbées, preuves (références stables, documents,
--      motifs), état AVANT / APRÈS borné, campagne et corrélation, tentatives
--      de réévaluation T4. Aucune donnée de contenu documentaire, aucun secret.
--
-- Additive et idempotente. Index dans 1000_..._idx_1 (CONCURRENTLY).
-- Retour arrière : l'ancien code ignore la table ; les absorptions restent
-- restaurables (BO › Rattrapages, journal 0591). DROP TABLE IF EXISTS
-- agenda_equivalence_decisions possible (aucune autre table ne la référence).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'agenda_intervention_consolidations')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
                      WHERE t.relname = 'agenda_intervention_consolidations' AND c.conname = 'agenda_intervention_consolidations_origin_chk'
                        AND pg_get_constraintdef(c.oid) LIKE '%COHERENCE%') THEN
    ALTER TABLE agenda_intervention_consolidations DROP CONSTRAINT IF EXISTS agenda_intervention_consolidations_origin_chk;
    ALTER TABLE agenda_intervention_consolidations ADD CONSTRAINT agenda_intervention_consolidations_origin_chk
      CHECK (origin IN ('PROJECTION', 'REPRISE', 'COHERENCE')) NOT VALID;
    ALTER TABLE agenda_intervention_consolidations VALIDATE CONSTRAINT agenda_intervention_consolidations_origin_chk;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS agenda_equivalence_decisions (
  id                        BIGSERIAL   PRIMARY KEY,
  account_id                INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id                  INTEGER,
  group_key                 TEXT        NOT NULL,
  fingerprint               TEXT        NOT NULL,
  verdict                   TEXT        NOT NULL,
  reason                    TEXT        NOT NULL,
  canonical_item_id         INTEGER,
  member_item_ids           INTEGER[]   NOT NULL DEFAULT '{}',
  absorbed_item_ids         INTEGER[]   NOT NULL DEFAULT '{}',
  absorbed_functional_keys  TEXT[]      NOT NULL DEFAULT '{}',
  protected_item_ids        INTEGER[]   NOT NULL DEFAULT '{}',
  evidence                  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  before_state              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  after_state               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  operation_id              BIGINT,
  t4_attempts               INTEGER     NOT NULL DEFAULT 0,
  t4_next_attempt_at        TIMESTAMPTZ,
  t4_last_status            TEXT,
  t4_journal_id             BIGINT,
  correlation_id            TEXT,
  campaign_id               BIGINT,
  trigger                   TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at               TIMESTAMPTZ,
  CONSTRAINT agenda_equivalence_decisions_verdict_chk CHECK (verdict IN (
    'CONSOLIDATED', 'DISTINCT', 'PROTECTED', 'UNCERTAIN', 'T4_PENDING', 'T4_UNAVAILABLE', 'T4_SAME', 'T4_DISTINCT', 'FAILED'))
);

COMMENT ON TABLE agenda_equivalence_decisions IS
  'Lot 106A : décisions d''équivalence des représentations Agenda d''un même fait (contrôle COH-AGENDA-EQUIVALENT-REPRESENTATIONS) — journal avant / après, remappage, file durable des réévaluations T4.';
