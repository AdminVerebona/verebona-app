-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0551 : identité persistante des cycles et sélection progressive T6
-- (lot 75E — ticket « [P1] T6 — Corriger les écarts résiduels de sélection,
-- preuves et rappels », corrections B et D).
--
--   t6_reminder_preferences
--     cycle_key        (D) cycle PERSISTANT de l'occurrence au moment du
--                      choix (portée OCCURRENCE) : `agenda:<id>#<n>`, n =
--                      nombre de réalisations tracées de l'occurrence
--                      (`agenda_occurrence_events` : STATUS_CHANGED « realise »,
--                      STATUS_AUTO_COMPLETED) — cohérent avec T4 (une ligne =
--                      une occurrence ; un nouveau cycle est une nouvelle
--                      occurrence, ou une occurrence réalisée puis rouverte).
--                      Remplace l'écart de 183 jours du lot 71G. Préférences
--                      existantes : cycle COURANT de leur échéance (aucun
--                      choix effacé ni levé).
--     series_asset_id  (D) bien de l'échéance d'où un refus de SÉRIE a été
--                      posé : le refus n'est retiré automatiquement que si
--                      ce bien n'existe plus dans le compte ET qu'aucune
--                      occurrence ne porte la série (invalidité établie) —
--                      plus de retrait après 365 jours sans occurrence.
--                      Préférences existantes : bien d'une occurrence de la
--                      série, si elle existe ; sinon NULL (jamais retirée
--                      automatiquement).
--
--   t6_candidate_examinations (B) — curseur PERSISTANT de la sélection T6
--     complémentaire : dernier examen achevé d'une échéance (signature des
--     données lues, empreinte, date de réexamen). Une échéance examinée
--     laisse sa place à la suivante ; elle revient dans la file dès que ses
--     données changent (A : y compris après SUPPRESS) ou à sa date de
--     réexamen. Écrit par la pré-génération du compte, idempotent (une
--     ligne par échéance, supprimée avec elle).
--
-- Colonnes NULLables (instantané, sans réécriture), table nouvelle. Le code
-- lit les colonnes par `to_jsonb(...)` et sonde leur présence avant d'écrire :
-- la fenêtre de déploiement est sans effet. Idempotente, rejouable.
-- Retour arrière : colonnes et table ignorées par le code du lot 74
-- (ALTER TABLE … DROP COLUMN IF EXISTS … / DROP TABLE IF EXISTS … possibles).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('t6_reminder_preferences') IS NOT NULL THEN
    ALTER TABLE t6_reminder_preferences
      ADD COLUMN IF NOT EXISTS cycle_key       TEXT,
      ADD COLUMN IF NOT EXISTS series_asset_id INTEGER;

    -- Préférences d'occurrence existantes : cycle COURANT de leur échéance.
    UPDATE t6_reminder_preferences p
       SET cycle_key = 'agenda:' || i.id || '#' || (
             SELECT count(*) FROM agenda_occurrence_events e
              WHERE e.agenda_item_id = i.id AND e.account_id = i.account_id
                AND (e.event_type = 'STATUS_AUTO_COMPLETED'
                     OR (e.event_type = 'STATUS_CHANGED' AND e.detail_json ->> 'manualStatus' = 'realise')))
      FROM agenda_items i
     WHERE p.scope = 'OCCURRENCE' AND p.cycle_key IS NULL
       AND i.id = p.agenda_item_id AND i.account_id = p.account_id;

    -- Refus de série existants : bien d'une occurrence de la série (du compte), s'il y en a une.
    UPDATE t6_reminder_preferences p
       SET series_asset_id = (
             SELECT min(l.asset_id)
               FROM agenda_items i
               JOIN agenda_asset_links l ON l.agenda_item_id = i.id
               JOIN assets a ON a.id = l.asset_id AND a.account_id = i.account_id
              WHERE i.account_id = p.account_id AND i.series_key = p.series_key)
     WHERE p.scope = 'SERIES' AND p.series_asset_id IS NULL;

    COMMENT ON COLUMN t6_reminder_preferences.cycle_key IS
      'Lot 75E : cycle persistant de l''occurrence choisie (agenda:<id>#<réalisations>). Différent du cycle courant : préférence non appliquée.';
    COMMENT ON COLUMN t6_reminder_preferences.series_asset_id IS
      'Lot 75E : bien d''où le refus de série a été posé. Retrait automatique seulement si ce bien n''existe plus dans le compte et qu''aucune occurrence ne porte la série.';
    COMMENT ON COLUMN t6_reminder_preferences.orphaned_since IS
      'Lot 71G : série sans aucune occurrence depuis cette date (SERIES). Lot 75E : supervision seulement, plus aucun retrait automatique.';
  END IF;

  IF to_regclass('agenda_items') IS NOT NULL AND to_regclass('accounts') IS NOT NULL THEN
    CREATE TABLE IF NOT EXISTS t6_candidate_examinations (
      agenda_item_id      INTEGER     PRIMARY KEY REFERENCES agenda_items(id) ON DELETE CASCADE,
      account_id          INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      examined_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      selection_signature TEXT        NOT NULL,
      context_fingerprint TEXT,
      recheck_on          DATE
    );
    CREATE INDEX IF NOT EXISTS t6_candidate_examinations_account_idx ON t6_candidate_examinations (account_id, recheck_on);

    COMMENT ON TABLE t6_candidate_examinations IS
      'Lot 75E : curseur persistant de la sélection T6 complémentaire (dernier examen achevé d''une échéance : signature des données, réexamen).';
  END IF;
END $$;
