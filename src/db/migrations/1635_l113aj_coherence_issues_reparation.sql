-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1635 : contrôle de cohérence — issues de réparation SANS
-- modification réelle (lot 113AJ, carte Trello #735 « Ne plus déclarer
-- « réparé » sans modification réelle », alerte BO n° 89).
--
--   coherence_repairs.outcome accepte deux valeurs ADDITIVES, posées
--   seulement par un contrôle qui qualifie lui-même ses réparations
--   (COH-MISSING-PROPERTIES et COH-MISSING-PROPERTIES-EQUIPMENT) :
--     ABSTAINED  analyse menée, abstention justifiée, aucune propriété écrite
--                (décisions conservées dans property_recovery_decisions) ;
--     UNCHANGED  rien à changer (plus rien en attente, objet disparu).
--   Les autres valeurs gardent leur sens : REPAIRED (écriture effective pour
--   ces deux contrôles), INEFFECTIVE, FAILED (échec technique / IA, budget),
--   PENDING (relance asynchrone).
--
-- Aucune donnée modifiée : l'historique REPAIRED sans écriture est requalifié
-- à la LECTURE (Supervision : `result.written` non vide), le journal d'audit
-- reste intact. Idempotente (rejouable). Retour arrière : l'ancien code
-- n'écrit jamais ABSTAINED / UNCHANGED ; le nouveau code retombe sur
-- INEFFECTIVE (jamais REPAIRED) si la contrainte n'accepte pas ces valeurs.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE coherence_repairs DROP CONSTRAINT IF EXISTS coherence_repairs_outcome_check;
ALTER TABLE coherence_repairs ADD CONSTRAINT coherence_repairs_outcome_check
  CHECK (outcome IN ('REPAIRED', 'INEFFECTIVE', 'FAILED', 'PENDING', 'ABSTAINED', 'UNCHANGED'));

COMMENT ON COLUMN coherence_repairs.outcome IS
  'Issue de la tentative : REPAIRED (réparation effective ; propriétés manquantes : au moins une écriture canonique), INEFFECTIVE, FAILED (échec technique ou IA, budget), PENDING (relance asynchrone), ABSTAINED (lot 113AJ : analyse avec abstention justifiée, rien écrit), UNCHANGED (lot 113AJ : rien à changer).';
