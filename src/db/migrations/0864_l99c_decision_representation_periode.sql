-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0864 : décision de REPRÉSENTATION TEMPORELLE du titre d'un document
-- (lot 99C, ticket « représentation temporelle des titres de documents »).
--
--   title_period_decision  décision de la branche T3 DOCUMENT_NAMING (contrat
--                          `t3-naming-period-v1`) pour une facture périodique :
--                          représentation (MONTH, DATE_RANGE, MULTI_MONTH,
--                          NONE), valeur (mois, bornes, mois de début et de
--                          fin), fondement, preuves, confiance, faits sur
--                          lesquels elle a été prise (`inputs`), version du
--                          prompt, trace, date — ou refus du serveur (motif).
--
-- Écrite UNIQUEMENT par la phase T3 DOCUMENT_NAMING après validation serveur
-- (`document-naming/period-representation.ts`) ; lue par le service de
-- nommage centralisé (`document-title.service.ts`) qui la RE-VALIDE à chaque
-- composition (une décision périmée ou invalide est ignorée : repli prudent).
-- Jamais écrite pour un titre utilisateur (title_source = 'USER').
--
-- Colonne NON déclarée dans Drizzle (même choix que 0760). Additive,
-- idempotente, NULL sans défaut (aucune réécriture de table), aucune reprise
-- de données. Exportée par le diagnostic global avec `asset_files`.
-- Retour arrière : ALTER TABLE asset_files DROP COLUMN IF EXISTS
--   title_period_decision (l'ancien code l'ignore).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE asset_files
  ADD COLUMN IF NOT EXISTS title_period_decision JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_files_title_period_decision_check') THEN
    ALTER TABLE asset_files ADD CONSTRAINT asset_files_title_period_decision_check
      CHECK (title_period_decision IS NULL OR jsonb_typeof(title_period_decision) = 'object') NOT VALID;
  END IF;
END
$$;
ALTER TABLE asset_files VALIDATE CONSTRAINT asset_files_title_period_decision_check;

COMMENT ON COLUMN asset_files.title_period_decision IS
  'Lot 99C : représentation temporelle du titre décidée par T3 DOCUMENT_NAMING (contrat t3-naming-period-v1), validée par le serveur, avec preuves et faits de référence.';
