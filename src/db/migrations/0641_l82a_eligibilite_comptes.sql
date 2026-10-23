-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0641 : éligibilité stricte des comptes aux traitements métier
-- (lot 82A — décision PO C-Q10 et §3.3 du 23/10/2026).
--
-- La règle d'éligibilité elle-même N'EST PAS stockée : elle est calculée à
-- chaque mise en file et à chaque exécution par
-- `src/services/account/processing-eligibility.ts` (droits effectifs
-- `entitlements.service` + suspension `accounts.is_active` + neutralisation
-- `accounts.archived_at`). Cette table ne sert qu'à DÉTECTER LES TRANSITIONS
-- (éligible → non éligible : neutralisation des travaux en attente / en
-- cours ; non éligible → éligible : réexamen des travaux et contrôle de
-- rattrapage, point d'entrée `onAccountReactivated`) et à en garder la
-- preuve technique (dates, motif, nombre de travaux neutralisés, rattrapage
-- demandé). Écrite par la tâche planifiée `account-eligibility-sync` et par
-- les transitions connues (suspension BO, fin d'essai, synchronisation
-- d'abonnement).
--
-- Une ligne par compte (clé primaire) : aucune croissance par exécution.
-- Pas de bien ni de fichier : hors classement des transferts de biens.
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS account_processing_states (
  account_id                integer PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  eligible                  boolean NOT NULL,
  reason                    text,
  observed_at               timestamptz NOT NULL DEFAULT now(),
  changed_at                timestamptz NOT NULL DEFAULT now(),
  last_neutralized_at       timestamptz,
  last_neutralized          jsonb,
  last_reactivated_at       timestamptz,
  last_reactivation_source  text,
  last_catchup_requested_at timestamptz,
  last_catchup_result       jsonb
);

COMMENT ON TABLE account_processing_states IS
  'Lot 82A (C-Q10) : dernier état d''éligibilité observé par compte — détection des transitions (neutralisation / reprise + rattrapage). La règle est calculée par processing-eligibility.ts.';
