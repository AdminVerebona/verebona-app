-- Migration 0053 — Vue de compatibilité deadlines → agenda_items
--
-- Objectif : fournir une vue lecture seule `deadlines_compat_view` qui expose
-- les agenda_items issus de la migration legacy (originType = 'legacy_deadline_migration')
-- sous l'ancienne forme deadlines, pour faciliter les comparaisons d'audit
-- et détecter les données non encore migrées.
--
-- Cette vue NE remplace PAS la table deadlines — elle coexiste le temps
-- de la migration complète, puis les deux (table + vue) seront supprimées.

CREATE OR REPLACE VIEW deadlines_compat_view AS
SELECT
  ai.id,
  ai.account_id,
  ai.created_by_user_id                              AS user_id,
  -- asset_id : on lit le premier lien asset lié (si présent)
  (
    SELECT aal.asset_id
    FROM agenda_asset_links aal
    WHERE aal.agenda_item_id = ai.id
    LIMIT 1
  )                                                   AS asset_id,
  ai.title                                            AS label,
  ai.start_date                                       AS deadline_date,
  ai.origin_field_key                                 AS deadline_type,
  CASE
    WHEN ai.manual_status = 'realise' THEN TRUE
    ELSE FALSE
  END                                                 AS is_done,
  NULL::date                                          AS done_date,
  ai.description                                      AS notes,
  ai.created_at,
  ai.updated_at,
  'legacy_deadline_migration'                         AS origin_type
FROM agenda_items ai
WHERE ai.origin_type = 'legacy_deadline_migration';

COMMENT ON VIEW deadlines_compat_view IS
  'Vue audit-only : expose les agenda_items issus de la migration deadlines legacy. '
  'Ne pas utiliser comme source de données applicative — utiliser agenda_items directement.';
