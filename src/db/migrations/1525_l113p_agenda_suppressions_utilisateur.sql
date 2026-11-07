-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1525 : agenda — trace persistante des SUPPRESSIONS UTILISATEUR
-- (lot 113P, ticket #715 « Agenda — Supprimer intégralement les statuts des
-- événements », décision PO du 06/11/2026).
--
-- Un événement inexistant, erroné ou « annulé » est désormais SUPPRIMÉ par
-- l'utilisateur. La suppression doit prévaloir sur toute réanalyse (T1, T3, T4,
-- contrôle de cohérence) : elle est tracée dans le journal EXISTANT des retraits
-- `agenda_item_removals` (0223, restaurable : image de l'élément et de ses liens),
-- motifs `USER_DELETED` (cet événement / cette occurrence) et
-- `USER_DELETED_SERIES` (toute la série). Aucune table nouvelle.
--
-- Cette migration ajoute seulement les INDEX de lecture de la règle de blocage
-- (`services/agenda/agenda-user-deletion.ts#userDeletionBlocks`) : par clé
-- fonctionnelle, par série, par champ d'origine et date.
--
-- Additive, idempotente, rejouable. Retour arrière : DROP INDEX des trois index.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS agenda_item_removals_user_key_idx
  ON agenda_item_removals (account_id, functional_key)
  WHERE reason IN ('USER_DELETED', 'USER_DELETED_SERIES') AND functional_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS agenda_item_removals_user_series_idx
  ON agenda_item_removals (account_id, (item_snapshot ->> 'series_key'))
  WHERE reason = 'USER_DELETED_SERIES';

CREATE INDEX IF NOT EXISTS agenda_item_removals_user_field_idx
  ON agenda_item_removals (account_id, (item_snapshot ->> 'origin_field_key'), start_date)
  WHERE reason IN ('USER_DELETED', 'USER_DELETED_SERIES');
