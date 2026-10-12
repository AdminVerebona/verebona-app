-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0315 : neutralisation des propagations génériques dangereuses
-- (lot 38, O0 — CDC Opérations V1 §19, §24, B18, B24, B32 étape 2, C18, C23).
--
-- Le seed manuel `src/services/coherence/seed-dependencies.ts` a pu insérer,
-- selon l'environnement, des règles GÉNÉRIQUES :
--   · documentDate → acquisitionDate / estimatedValueDate ;
--   · amountCents  → acquisitionPrice / estimatedValue ;
--   · supplier     → acquisitionLocation ;
--   · créations d'agenda génériques (documentDate_agenda,
--     equipment_maintenance_agenda, mileage_agenda) — l'agenda relève de T4.
-- « Aucun montant documentaire générique ne doit contaminer valorisation ou
-- acquisition » (C18). Ces règles sont DÉSACTIVÉES (is_active = false), pas
-- supprimées : l'historique reste lisible et la décision réversible.
--
-- Par prudence, toute règle de PROPAGATION encore active vers une cible
-- d'acquisition ou de valorisation est aussi désactivée (le moteur les ignore
-- désormais de toute façon : défense en profondeur).
--
-- Idempotente (rejouable sans effet) ; sans effet si la table n'existe pas.
-- ──────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.field_dependencies') IS NULL THEN
    RETURN;
  END IF;

  UPDATE field_dependencies
     SET is_active = false,
         updated_at = now()
   WHERE is_active = true
     AND (
       (source_field = 'documentDate' AND target_field IN ('acquisitionDate', 'estimatedValueDate', 'documentDate_agenda'))
       OR (source_field = 'amountCents' AND target_field IN ('acquisitionPrice', 'estimatedValue'))
       OR (source_field = 'supplier' AND target_field = 'acquisitionLocation')
       OR impact_type = 'agenda_creation'
       OR (impact_type = 'propagation' AND target_field IN (
             'acquisitionDate', 'acquisitionPrice', 'acquisitionLocation', 'acquisitionCurrency',
             'estimatedValue', 'estimatedValueDate', 'estimatedValueMode', 'estimatedValueCurrency',
             'valuationLow', 'valuationHigh', 'valuationDate', 'valuationSource'))
     );
END $$;
