-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1515 : coût de possession — CONFIRMATION d'une dépense conservée
-- sans date économique établie (lot 113N, carte #712 « [P1][Pré-MEP] TCO —
-- Confirmer une dépense conservée sans date et clôturer le point à vérifier »).
--
-- Étend la table des décisions du lot 80A (0623, élargie en 1320) au lieu d'en
-- créer une nouvelle : la confirmation « je conserve cette dépense sans date »
-- est une décision TYPÉE DISTINCTE de l'inclusion / exclusion, portée par la
-- même clé stable de la ligne (même rattachement au fait économique, même
-- re-clé lors d'une reconstruction des Opérations) mais dans des colonnes
-- propres — jamais une valeur de `decision` :
--
--   date_decision    'CONFIRM_UNDATED' (seule valeur), NULL sinon ;
--   date_decided_at  horodatage de la confirmation ;
--   date_decided_by  auteur (utilisateur).
--
-- `decision` devient NULLable : une ligne seulement confirmée « sans date »
-- n'a aucune décision d'inclusion / exclusion (jamais une inclusion fictive).
-- Garde-fou : au moins l'une des deux décisions est présente.
-- Un code antérieur ignore les lignes à `decision` NULL (lecture filtrée sur
-- les valeurs connues) : aucune décision appliquée à tort.
--
-- Journal `asset_cost_line_decision_events` : actions CONFIRM_UNDATED et
-- REVERT_UNDATED (annulation de la confirmation), previous_decision idem.
--
-- Idempotente et rejouable (ADD COLUMN IF NOT EXISTS, contraintes recréées à
-- l'identique). Élargissement seulement : toute ligne existante reste valide.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE asset_cost_line_decisions ADD COLUMN IF NOT EXISTS date_decision   TEXT;
ALTER TABLE asset_cost_line_decisions ADD COLUMN IF NOT EXISTS date_decided_at TIMESTAMPTZ;
ALTER TABLE asset_cost_line_decisions ADD COLUMN IF NOT EXISTS date_decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE asset_cost_line_decisions ALTER COLUMN decision DROP NOT NULL;

ALTER TABLE asset_cost_line_decisions DROP CONSTRAINT IF EXISTS asset_cost_line_decisions_date_decision_chk;
ALTER TABLE asset_cost_line_decisions ADD CONSTRAINT asset_cost_line_decisions_date_decision_chk
  CHECK (date_decision IS NULL OR (date_decision = 'CONFIRM_UNDATED' AND date_decided_at IS NOT NULL));
ALTER TABLE asset_cost_line_decisions DROP CONSTRAINT IF EXISTS asset_cost_line_decisions_some_decision_chk;
ALTER TABLE asset_cost_line_decisions ADD CONSTRAINT asset_cost_line_decisions_some_decision_chk
  CHECK (decision IS NOT NULL OR date_decision IS NOT NULL);

ALTER TABLE asset_cost_line_decision_events DROP CONSTRAINT IF EXISTS asset_cost_line_decision_events_action_chk;
ALTER TABLE asset_cost_line_decision_events ADD CONSTRAINT asset_cost_line_decision_events_action_chk
  CHECK (action IN ('INCLUDE', 'EXCLUDE', 'REVERT', 'CONFIRM_EXCLUSION', 'SAME_FACT', 'DISTINCT_FACTS', 'REQUALIFY', 'CONFIRM_UNDATED', 'REVERT_UNDATED'));
ALTER TABLE asset_cost_line_decision_events DROP CONSTRAINT IF EXISTS asset_cost_line_decision_events_previous_chk;
ALTER TABLE asset_cost_line_decision_events ADD CONSTRAINT asset_cost_line_decision_events_previous_chk
  CHECK (previous_decision IS NULL OR previous_decision IN ('INCLUDE', 'EXCLUDE', 'CONFIRM_EXCLUSION', 'SAME_FACT', 'DISTINCT_FACTS', 'REQUALIFY', 'CONFIRM_UNDATED'));

COMMENT ON COLUMN asset_cost_line_decisions.date_decision IS
  'Lot 113N : CONFIRM_UNDATED — l''utilisateur conserve la dépense dans le TCO sans date économique établie (ne neutralise que ECONOMIC_DATE_UNDETERMINED ; indépendante de decision).';
