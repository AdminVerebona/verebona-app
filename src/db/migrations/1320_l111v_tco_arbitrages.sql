-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1320 : coût de possession — ARBITRAGES explicites de l'utilisateur
-- (lot 111V, ticket P1 « TCO — rendre chaque anomalie corrigeable, fiabiliser
-- les exclusions et clôturer les arbitrages »).
--
-- Étend les tables du lot 80A (0623) au lieu d'en créer de nouvelles :
--
--   asset_cost_line_decisions.decision accepte, en plus de INCLUDE / EXCLUDE :
--     CONFIRM_EXCLUSION  ligne non retenue confirmée comme exclue (total inchangé) ;
--     SAME_FACT          même fait économique qu'une dépense déjà comptée ;
--     DISTINCT_FACTS     transactions / échéances distinctes (même montant possible) ;
--     REQUALIFY          nature confirmée : dépense de ce bien (catégorie choisie).
--   Colonnes ajoutées (toutes NULLables, aucune valeur existante modifiée) :
--     related_line_keys     clés stables des autres lignes de l'arbitrage (doublon) ;
--     requalified_category  catégorie choisie (REQUALIFY) ;
--     automatic_status / automatic_reason  traitement automatique au moment du
--       choix — une preuve nouvelle qui le contredit ROUVRE le point (motivé),
--       sans jamais effacer la décision.
--
--   asset_cost_line_decision_events.action accepte les mêmes valeurs (+ REVERT) ;
--   previous_decision aussi ; colonnes related_line_keys et detail (jsonb borné).
--
-- Idempotente et rejouable (ADD COLUMN IF NOT EXISTS, contraintes recréées à
-- l'identique). Élargissement seulement : toute ligne existante reste valide.
-- Retour arrière : les nouvelles valeurs sont ignorées par un code antérieur
-- (lecture filtrée INCLUDE / EXCLUDE) ; colonnes supprimables sans perte des
-- décisions 80A.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE asset_cost_line_decisions ADD COLUMN IF NOT EXISTS related_line_keys    TEXT[];
ALTER TABLE asset_cost_line_decisions ADD COLUMN IF NOT EXISTS requalified_category TEXT;
ALTER TABLE asset_cost_line_decisions ADD COLUMN IF NOT EXISTS automatic_status     TEXT;
ALTER TABLE asset_cost_line_decisions ADD COLUMN IF NOT EXISTS automatic_reason     TEXT;

ALTER TABLE asset_cost_line_decisions DROP CONSTRAINT IF EXISTS asset_cost_line_decisions_decision_chk;
ALTER TABLE asset_cost_line_decisions ADD CONSTRAINT asset_cost_line_decisions_decision_chk
  CHECK (decision IN ('INCLUDE', 'EXCLUDE', 'CONFIRM_EXCLUSION', 'SAME_FACT', 'DISTINCT_FACTS', 'REQUALIFY'));
ALTER TABLE asset_cost_line_decisions DROP CONSTRAINT IF EXISTS asset_cost_line_decisions_related_chk;
ALTER TABLE asset_cost_line_decisions ADD CONSTRAINT asset_cost_line_decisions_related_chk
  CHECK (related_line_keys IS NULL OR cardinality(related_line_keys) <= 20);
ALTER TABLE asset_cost_line_decisions DROP CONSTRAINT IF EXISTS asset_cost_line_decisions_category_chk;
ALTER TABLE asset_cost_line_decisions ADD CONSTRAINT asset_cost_line_decisions_category_chk
  CHECK (requalified_category IS NULL OR length(requalified_category) <= 40);

ALTER TABLE asset_cost_line_decision_events ADD COLUMN IF NOT EXISTS related_line_keys TEXT[];
ALTER TABLE asset_cost_line_decision_events ADD COLUMN IF NOT EXISTS detail            JSONB;

ALTER TABLE asset_cost_line_decision_events DROP CONSTRAINT IF EXISTS asset_cost_line_decision_events_action_chk;
ALTER TABLE asset_cost_line_decision_events ADD CONSTRAINT asset_cost_line_decision_events_action_chk
  CHECK (action IN ('INCLUDE', 'EXCLUDE', 'REVERT', 'CONFIRM_EXCLUSION', 'SAME_FACT', 'DISTINCT_FACTS', 'REQUALIFY'));
ALTER TABLE asset_cost_line_decision_events DROP CONSTRAINT IF EXISTS asset_cost_line_decision_events_previous_chk;
ALTER TABLE asset_cost_line_decision_events ADD CONSTRAINT asset_cost_line_decision_events_previous_chk
  CHECK (previous_decision IS NULL OR previous_decision IN ('INCLUDE', 'EXCLUDE', 'CONFIRM_EXCLUSION', 'SAME_FACT', 'DISTINCT_FACTS', 'REQUALIFY'));
ALTER TABLE asset_cost_line_decision_events DROP CONSTRAINT IF EXISTS asset_cost_line_decision_events_detail_chk;
ALTER TABLE asset_cost_line_decision_events ADD CONSTRAINT asset_cost_line_decision_events_detail_chk
  CHECK (detail IS NULL OR (jsonb_typeof(detail) = 'object' AND length(detail::text) <= 2000));

COMMENT ON COLUMN asset_cost_line_decisions.automatic_status IS
  'Lot 111V : statut automatique de la ligne au moment du choix (réouverture motivée si une preuve nouvelle le contredit ; la décision n''est jamais effacée).';
