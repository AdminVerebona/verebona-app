-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0744 : date économique RETENUE des composantes financières et sa
-- provenance (lot 86F, ticket P1 « TCO / Opérations : dates économiques
-- injustifiées et leur autoréparation », complément du ticket #559).
--
-- La date économique d'une composante est RÉSOLUE à chaque lecture par la
-- règle pure `finance/economic-date.ts` (paiement prouvé, date propre du
-- montant, date du justificatif, réalisation d'une Opération ponctuelle à
-- fait unique ; jamais la date de l'Opération par défaut). Ces colonnes en
-- conservent la TRACE retenue, écrite UNIQUEMENT par le service
-- `business-operations/finance/economic-date.service.ts` (contrôle de
-- cohérence COH-TCO-ECONOMIC-DATES, réparation du stock) :
--   economic_date_basis        fondement (PAYMENT, AMOUNT_DATE, DOCUMENT,
--                              OPERATION_SINGLE_FACT) ou UNDETERMINED ;
--   resolved_economic_date     date retenue (NULL : non établie — la dépense
--                              compte sans année) ;
--   economic_date_trace        résolution complète (version de règle,
--                              provenance, justification, dates disponibles
--                              retenues / rejetées et motif) ;
--   economic_date_resolved_at  horodatage de la trace.
-- `economic_date` (date propre lue sur la source, écrite par T3) n'est JAMAIS
-- réécrite : la consolidation reste seule propriétaire du fait. Chaque
-- changement de trace est journalisé dans `business_operation_history`
-- (FINANCIAL_CHANGED / ECONOMIC_DATE_RESOLVED, avant / après).
--
-- Colonnes NON déclarées dans Drizzle (même choix que 0351) : lues et écrites en
-- SQL par le service ci-dessus ; le schéma Drizzle de la table reste celui de 0316
-- (test « tables neuves : Drizzle = SQL »).
--
-- Additive, idempotente, aucune reprise de données (le stock est repris par le
-- contrôle de cohérence, campagne quotidienne et contrôles ciblés). Colonnes
-- NULL sans défaut : aucune réécriture de table. Contrainte posée NOT VALID
-- (aucun balayage sous verrou ; appliquée à toute écriture — les lignes
-- existantes ont toutes la colonne NULL).
-- Retour arrière : ALTER TABLE business_operation_financial_components
--   DROP COLUMN IF EXISTS economic_date_basis, DROP COLUMN IF EXISTS
--   resolved_economic_date, DROP COLUMN IF EXISTS economic_date_trace,
--   DROP COLUMN IF EXISTS economic_date_resolved_at (code tolérant : la
--   résolution à la lecture ne dépend pas de ces colonnes).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE business_operation_financial_components
  ADD COLUMN IF NOT EXISTS economic_date_basis       TEXT,
  ADD COLUMN IF NOT EXISTS resolved_economic_date    DATE,
  ADD COLUMN IF NOT EXISTS economic_date_trace       JSONB,
  ADD COLUMN IF NOT EXISTS economic_date_resolved_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_financial_components_economic_date_basis_chk'
                   AND conrelid = 'business_operation_financial_components'::regclass) THEN
    ALTER TABLE business_operation_financial_components
      ADD CONSTRAINT business_operation_financial_components_economic_date_basis_chk
      CHECK (economic_date_basis IS NULL OR economic_date_basis IN ('PAYMENT', 'AMOUNT_DATE', 'DOCUMENT', 'OPERATION_SINGLE_FACT', 'UNDETERMINED')) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN business_operation_financial_components.economic_date_basis IS
  'Lot 86F : fondement de la date économique retenue (PAYMENT, AMOUNT_DATE, DOCUMENT, OPERATION_SINGLE_FACT) ou UNDETERMINED — trace écrite par economic-date.service (contrôle COH-TCO-ECONOMIC-DATES).';
COMMENT ON COLUMN business_operation_financial_components.resolved_economic_date IS
  'Lot 86F : date économique retenue (NULL : non établie, la dépense compte sans année). Jamais la date de l''Opération par défaut.';
COMMENT ON COLUMN business_operation_financial_components.economic_date_trace IS
  'Lot 86F : résolution complète (version de règle, provenance, justification, dates disponibles retenues ou rejetées).';
