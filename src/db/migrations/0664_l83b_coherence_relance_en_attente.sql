-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0664 : contrôle de cohérence — relance ASYNCHRONE tracée (lot 83B,
-- arbitrage C-Q7 « interroger l'extract et cibler le maillon défaillant » ;
-- C-Q2 « tracer l'origine, les changements, le résultat »).
--
--   coherence_repairs.outcome accepte 'PENDING' : une réparation qui RELANCE
--   un traitement par une file existante (nouvelle extraction source par la
--   file T1) n'a pas de résultat immédiat. La tentative reste PENDING ; le
--   contrôle suivant de l'objet en observe le résultat et la clôt
--   (REPAIRED si l'objet est devenu cohérent, INEFFECTIVE sinon) —
--   chaîne tracée diagnostic → relance → résultat ;
--   coherence_repairs.settled_at — instant de cette clôture.
--
-- Aucune donnée métier. Idempotente (rejouable). Retour arrière : l'ancien
-- code n'écrit jamais 'PENDING' et ignore la colonne.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE coherence_repairs ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;

ALTER TABLE coherence_repairs DROP CONSTRAINT IF EXISTS coherence_repairs_outcome_check;
ALTER TABLE coherence_repairs ADD CONSTRAINT coherence_repairs_outcome_check
  CHECK (outcome IN ('REPAIRED', 'INEFFECTIVE', 'FAILED', 'PENDING'));

COMMENT ON COLUMN coherence_repairs.settled_at IS
  'Lot 83B : clôture d''une relance asynchrone (outcome PENDING → REPAIRED / INEFFECTIVE) au contrôle suivant de l''objet.';
