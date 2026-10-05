-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0236 : cible ÉQUIPEMENT / PIÈCE des lignes `ai_field_updates`
-- (lot 22, chantier B — « Ce que j'ai fait »).
--
-- Depuis le lot 18 (0227) et la décision D-G (lot 20, 0229), une valeur lue
-- pour un équipement ou une pièce (sous-structure) s'écrit sur SA fiche par
-- `writeCanonicalEntityField`. Le journal 0216 (`canonical_field_writes`)
-- porte la cible, mais `ai_field_updates` — la table lue par l'accueil
-- (« Ce que j'ai fait »), l'historique des enrichissements et l'annulation —
-- n'en avait pas : la primitive n'y écrivait donc rien, et l'utilisateur ne
-- voyait jamais ces écritures.
--
--   ai_field_updates.target_type / target_id
--       NULL = le bien `asset_id` (toutes les lignes existantes) ;
--       EQUIPMENT (`equipments.id`) | ROOM (`substructures.id`) sinon —
--       `asset_id` reste le bien PORTEUR (cloisonnement par compte, cascade
--       de suppression et filtre « Bien » inchangés).
--
-- RÉTROCOMPATIBLE : colonnes nullables, AUCUNE réécriture de table ni de
-- donnée ; les lecteurs qui interprètent une ligne comme un champ du BIEN
-- filtrent `target_type IS NULL`. Colonnes NON déclarées dans Drizzle (même
-- choix que 0227) : `db.select()` sans projection existe sur cette table ;
-- tout passe en SQL après contrôle de présence
-- (`canonical/entity-state/entity-schema.ts`, `aiFieldUpdatesTargetReady`).
-- Migration absente : aucune ligne d'entité n'est écrite (comportement
-- antérieur), rien n'échoue.
--
-- VERROUS : ADD COLUMN sous ACCESS EXCLUSIVE, bref ; `lock_timeout` 5 s.
-- Dépassé : la migration échoue, est signalée et retentée au démarrage
-- suivant. Contrainte ajoutée NOT VALID (aucun parcours de la table).
-- Idempotente : IF NOT EXISTS ; contrainte ajoutée si absente.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_field_updates
  ADD COLUMN IF NOT EXISTS target_type TEXT,
  ADD COLUMN IF NOT EXISTS target_id   INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ai_field_updates_target_ck'
                    AND conrelid = 'ai_field_updates'::regclass) THEN
    ALTER TABLE ai_field_updates
      ADD CONSTRAINT ai_field_updates_target_ck
      CHECK ((target_type IS NULL AND target_id IS NULL)
          OR (target_type IN ('EQUIPMENT', 'ROOM') AND target_id IS NOT NULL)) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN ai_field_updates.target_type IS
  'Cible de l''écriture automatique : NULL = le bien asset_id ; EQUIPMENT | ROOM (asset_id = bien porteur). Lot 22.';
COMMENT ON COLUMN ai_field_updates.target_id IS
  'Identifiant de la cible : equipments.id (EQUIPMENT) ou substructures.id (ROOM). NULL pour le bien.';
