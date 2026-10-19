-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0507 : écarts de décision d'interpellation T6 et rappels (lot 71G —
-- ticket « [P1] T6 — Corriger les écarts de décision d'interpellation et
-- fiabiliser les rappels »).
--
--   t6_reminder_preferences
--     occurrence_date   date de l'occurrence au moment du choix (portée
--                       OCCURRENCE) — T6-07 : une replanification du même
--                       événement conserve la préférence ; un nouveau cycle
--                       (identifiant réutilisé par T4, date décalée d'un
--                       cycle) n'hérite pas du refus « cette échéance ».
--                       Préférences existantes : renseignée avec la date
--                       ACTUELLE de l'échéance (aucun refus perdu).
--     orphaned_since    première constatation qu'aucune occurrence du compte
--                       ne porte plus la série (portée SERIES) — un refus de
--                       série survit à une régénération T4 ; retiré
--                       seulement après un an d'absence continue.
--
--   t6_interpellation_assessments
--     evidence_snapshot  preuves CITÉES par la décision et leurs versions
--                        (document, extraction, fait) — références seules,
--                        aucun texte (T6-04, reporting §6) ;
--     reevaluation_reason motif de la (ré)évaluation (première évaluation,
--                        contexte changé, report arrivé à sa date…).
--
-- Colonnes NULLables (instantané, sans réécriture). Le code les lit par
-- `to_jsonb(...)` et sonde leur présence avant d'écrire : la fenêtre de
-- déploiement est sans effet. Idempotente, rejouable.
-- Retour arrière : colonnes ignorées par le code du lot 70 (ALTER TABLE …
-- DROP COLUMN IF EXISTS … possible).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('t6_reminder_preferences') IS NOT NULL THEN
    ALTER TABLE t6_reminder_preferences
      ADD COLUMN IF NOT EXISTS occurrence_date DATE,
      ADD COLUMN IF NOT EXISTS orphaned_since  DATE;

    -- Préférences d'occurrence existantes : cycle = date actuelle de l'échéance.
    UPDATE t6_reminder_preferences p
       SET occurrence_date = i.start_date
      FROM agenda_items i
     WHERE p.scope = 'OCCURRENCE' AND p.occurrence_date IS NULL
       AND i.id = p.agenda_item_id AND i.start_date IS NOT NULL;

    COMMENT ON COLUMN t6_reminder_preferences.occurrence_date IS
      'Lot 71G : date de l''occurrence choisie (OCCURRENCE). Écart d''un cycle (≥ 183 jours) : nouveau cycle, préférence non appliquée.';
    COMMENT ON COLUMN t6_reminder_preferences.orphaned_since IS
      'Lot 71G : série sans aucune occurrence depuis cette date (SERIES). Retirée après 365 jours d''absence continue.';
  END IF;

  IF to_regclass('t6_interpellation_assessments') IS NOT NULL THEN
    ALTER TABLE t6_interpellation_assessments
      ADD COLUMN IF NOT EXISTS evidence_snapshot   JSONB,
      ADD COLUMN IF NOT EXISTS reevaluation_reason TEXT;

    COMMENT ON COLUMN t6_interpellation_assessments.evidence_snapshot IS
      'Lot 71G : preuves citées par la décision et leurs versions (références : document, extraction, fait) — aucun texte.';
    COMMENT ON COLUMN t6_interpellation_assessments.reevaluation_reason IS
      'Lot 71G : motif de la (ré)évaluation (FIRST_ASSESSMENT, CONTEXT_CHANGED, AGED, REVIEW_DATE, SNOOZE_DUE…).';
  END IF;
END $$;
