-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0474 : rappel informatif T6 (lot 68 — ticket « [P2] Accueil / T6 —
-- Alléger la bulle et distinguer rappel informatif et action »).
--
-- Le contrat `t6-evaluation-v1` admet désormais SHOW_NOW + INFORMATION (motif
-- `INFORMATIVE_REMINDER`, sans action attendue). La décision est conservée
-- dans `t6_interpellation_assessments` (0432, 0447) avec la valeur historique
-- DÉRIVÉE `interpellation = 'INFORM'` — que la contrainte de 0432 refusait
-- (ACT_NOW, ANTICIPATE, LATER, NONE) : elle est élargie.
--
--   contract_revision  1 : décision d'une version du prompt qui ne connaît pas
--                      le rappel informatif (lignes existantes) ; 2 : version
--                      porteuse de la règle. Sert au renouvellement CIBLÉ :
--                      seules les décisions de révision 1 susceptibles de
--                      changer (SHOW_NOW, SUPPRESS « NO_ACTION_REQUIRED ») sont
--                      réévaluées en arrière-plan, une fois la nouvelle version
--                      du prompt active — sans quitter l'accueil entre-temps.
--
-- Colonne à défaut constant (instantané, sans réécriture). Contrainte
-- remplacée en NOT VALID puis validée (lignes existantes conformes).
-- Idempotente, rejouable.
-- Retour arrière : le code du lot 67 ignore la colonne ; une ligne 'INFORM'
-- est alors lue comme une conclusion inconnue (aucune interpellation).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('t6_interpellation_assessments') IS NULL THEN RETURN; END IF;

  ALTER TABLE t6_interpellation_assessments
    ADD COLUMN IF NOT EXISTS contract_revision SMALLINT NOT NULL DEFAULT 1;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 't6_interpellation_assessments_revision_check') THEN
    ALTER TABLE t6_interpellation_assessments ADD CONSTRAINT t6_interpellation_assessments_revision_check
      CHECK (contract_revision BETWEEN 1 AND 9) NOT VALID;
    ALTER TABLE t6_interpellation_assessments VALIDATE CONSTRAINT t6_interpellation_assessments_revision_check;
  END IF;

  -- Contrainte de 0432 élargie à 'INFORM' (rappel informatif), une seule fois.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 't6_interpellation_assessments_interpellation_check'
       AND pg_get_constraintdef(oid) LIKE '%INFORM''%'
  ) THEN
    ALTER TABLE t6_interpellation_assessments DROP CONSTRAINT IF EXISTS t6_interpellation_assessments_interpellation_check;
    ALTER TABLE t6_interpellation_assessments ADD CONSTRAINT t6_interpellation_assessments_interpellation_check
      CHECK (interpellation IN ('ACT_NOW', 'ANTICIPATE', 'INFORM', 'LATER', 'NONE')) NOT VALID;
    ALTER TABLE t6_interpellation_assessments VALIDATE CONSTRAINT t6_interpellation_assessments_interpellation_check;
  END IF;

  COMMENT ON COLUMN t6_interpellation_assessments.contract_revision IS
    'Lot 68 : 1 = prompt sans rappel informatif (renouvelée de façon ciblée), 2 = prompt porteur de la règle INFORMATIVE_REMINDER.';
END $$;
