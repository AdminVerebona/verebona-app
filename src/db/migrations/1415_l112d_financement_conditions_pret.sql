-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1415 : conditions d'un prêt SAISIES (USER / ADMIN) pour établir
-- le capital restant dû (lot 112D, ticket « TCO / financement — capital
-- restant dû »).
--
-- Étend le modèle FINANCING existant (`business_operation_financing_details`,
-- 0317) au lieu de créer un second référentiel. Colonnes ADDITIVES, toutes
-- NULLables, réservées aux SAISIES de l'utilisateur ou du support : les
-- conditions lues sur les documents (tableau d'amortissement, offre,
-- attestation) sont relues à chaque calcul et ne sont JAMAIS recopiées ici ;
-- une saisie n'est donc jamais remplacée par une lecture documentaire
-- (protection par construction). La consolidation (syncDetails) n'écrit que
-- ses propres colonnes : elle ne touche pas à celles-ci.
--
--   loan_principal_minor           montant emprunté saisi (prime sur le
--                                  capital consolidé `principal_amount_minor`)
--   loan_nominal_rate_pct          taux nominal annuel en % (« 3.25 »)
--   loan_periodicity               MONTHLY | QUARTERLY | SEMIANNUAL | ANNUAL
--   loan_duration_months           durée totale, différé compris (1 à 600)
--   loan_first_installment_date    date de la première échéance
--   loan_installment_minor         échéance HORS assurance
--   loan_insurance_minor           assurance emprunteur par échéance
--   loan_deferral_months / _kind   différé (0 = aucun ; PARTIAL | TOTAL | NONE)
--   loan_terms_origin              origine PAR CHAMP { champ: { origin:
--                                  USER | ADMIN, at, userId } }
--   loan_events                    capitaux restants dus saisis à une date et
--                                  remboursements anticipés (tableau borné)
--
-- Le capital restant dû n'est jamais un coût (règle 111F) : aucune de ces
-- colonnes n'est lue par le calcul des coûts.
--
-- Additive, idempotente, rejouable ; aucune reprise de données.
-- Retour arrière : ALTER TABLE … DROP COLUMN IF EXISTS des onze colonnes
-- (le code antérieur ne les lit pas).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE business_operation_financing_details ADD COLUMN IF NOT EXISTS loan_principal_minor        BIGINT;
ALTER TABLE business_operation_financing_details ADD COLUMN IF NOT EXISTS loan_nominal_rate_pct       NUMERIC(9,6);
ALTER TABLE business_operation_financing_details ADD COLUMN IF NOT EXISTS loan_periodicity            TEXT;
ALTER TABLE business_operation_financing_details ADD COLUMN IF NOT EXISTS loan_duration_months        INTEGER;
ALTER TABLE business_operation_financing_details ADD COLUMN IF NOT EXISTS loan_first_installment_date DATE;
ALTER TABLE business_operation_financing_details ADD COLUMN IF NOT EXISTS loan_installment_minor      BIGINT;
ALTER TABLE business_operation_financing_details ADD COLUMN IF NOT EXISTS loan_insurance_minor        BIGINT;
ALTER TABLE business_operation_financing_details ADD COLUMN IF NOT EXISTS loan_deferral_months        INTEGER;
ALTER TABLE business_operation_financing_details ADD COLUMN IF NOT EXISTS loan_deferral_kind          TEXT;
ALTER TABLE business_operation_financing_details ADD COLUMN IF NOT EXISTS loan_terms_origin           JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE business_operation_financing_details ADD COLUMN IF NOT EXISTS loan_events                 JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE business_operation_financing_details DROP CONSTRAINT IF EXISTS business_operation_financing_details_loan_amounts_chk;
ALTER TABLE business_operation_financing_details ADD CONSTRAINT business_operation_financing_details_loan_amounts_chk
  CHECK ((loan_principal_minor IS NULL OR loan_principal_minor > 0)
     AND (loan_installment_minor IS NULL OR loan_installment_minor > 0)
     AND (loan_insurance_minor IS NULL OR loan_insurance_minor >= 0));
ALTER TABLE business_operation_financing_details DROP CONSTRAINT IF EXISTS business_operation_financing_details_loan_rate_chk;
ALTER TABLE business_operation_financing_details ADD CONSTRAINT business_operation_financing_details_loan_rate_chk
  CHECK (loan_nominal_rate_pct IS NULL OR (loan_nominal_rate_pct >= 0 AND loan_nominal_rate_pct < 100));
ALTER TABLE business_operation_financing_details DROP CONSTRAINT IF EXISTS business_operation_financing_details_loan_periodicity_chk;
ALTER TABLE business_operation_financing_details ADD CONSTRAINT business_operation_financing_details_loan_periodicity_chk
  CHECK (loan_periodicity IS NULL OR loan_periodicity IN ('MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'));
ALTER TABLE business_operation_financing_details DROP CONSTRAINT IF EXISTS business_operation_financing_details_loan_duration_chk;
ALTER TABLE business_operation_financing_details ADD CONSTRAINT business_operation_financing_details_loan_duration_chk
  CHECK ((loan_duration_months IS NULL OR loan_duration_months BETWEEN 1 AND 600)
     AND (loan_deferral_months IS NULL OR loan_deferral_months BETWEEN 0 AND 600));
ALTER TABLE business_operation_financing_details DROP CONSTRAINT IF EXISTS business_operation_financing_details_loan_deferral_chk;
ALTER TABLE business_operation_financing_details ADD CONSTRAINT business_operation_financing_details_loan_deferral_chk
  CHECK (loan_deferral_kind IS NULL OR loan_deferral_kind IN ('NONE', 'PARTIAL', 'TOTAL'));
ALTER TABLE business_operation_financing_details DROP CONSTRAINT IF EXISTS business_operation_financing_details_loan_json_chk;
ALTER TABLE business_operation_financing_details ADD CONSTRAINT business_operation_financing_details_loan_json_chk
  CHECK (jsonb_typeof(loan_terms_origin) = 'object' AND length(loan_terms_origin::text) <= 4000
     AND jsonb_typeof(loan_events) = 'array' AND jsonb_array_length(loan_events) <= 50 AND length(loan_events::text) <= 20000);

COMMENT ON COLUMN business_operation_financing_details.loan_terms_origin IS
  'Lot 112D : origine PAR CHAMP des conditions saisies (USER / ADMIN, date, auteur). Les conditions lues sur les documents ne sont jamais recopiées ici.';
COMMENT ON COLUMN business_operation_financing_details.loan_events IS
  'Lot 112D : capitaux restants dus saisis à une date (BALANCE) et remboursements anticipés (EARLY_REPAYMENT), au plus 50.';
