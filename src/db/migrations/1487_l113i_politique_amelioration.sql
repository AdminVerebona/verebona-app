-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1487 : politique administrée de l'amélioration automatique IA (lot
-- 113I, CDC V2 §16.2 BO-05, §36, DEC-08, EVA-006, UI-003). Service :
-- `src/services/ai/qualification/improvement-policy.ts`.
--
-- Justification : budget d'amélioration en EUR (100 / 80 / 20, alertes 50 / 75),
-- conversion de devise administrée, bornes de coût, variantes par objectif,
-- bornes économiques et de latence par traitement, modèles stables attestés.
-- `ai_cost_settings` (budgets MÉTIER informatifs en USD, par périmètre) ne peut
-- pas les porter sans mélanger les deux budgets (INV-06, C-007). Révisions
-- APPEND-ONLY : auteur, date d'effet, motif, empreinte (DEC-08). Le moteur n'a
-- aucun chemin d'écriture (seule la route BO administrateur écrit).
-- Non exportée vers la production (PRD-04).
-- Additive, idempotente. Retour arrière : DROP TABLE ai_improvement_policy_revisions
-- (le code revient aux valeurs de départ : aucun appel payant sans taux FX).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_improvement_policy_revisions (
  id           BIGSERIAL    PRIMARY KEY,
  environment  TEXT         NOT NULL,
  revision     INTEGER      NOT NULL,
  policy       JSONB        NOT NULL,
  sha256       TEXT         NOT NULL,
  created_by   INTEGER      NOT NULL,
  reason       TEXT         NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_improvement_policy_revision_chk CHECK (revision > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_improvement_policy_env_rev_uidx ON ai_improvement_policy_revisions (environment, revision);
COMMENT ON TABLE ai_improvement_policy_revisions IS
  'Lot 113I : politique administrée de l''amélioration automatique IA (préproduction), révisions append-only avec auteur, motif et empreinte. Jamais écrite par le moteur.';
