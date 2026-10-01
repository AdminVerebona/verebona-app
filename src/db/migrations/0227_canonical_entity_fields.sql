-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0227 : champs canoniques d'un ÉQUIPEMENT et d'une PIÈCE (CDC 15
-- T1-04, T3-01, T3-02, T3-05 ; plan lot 18, volet R3).
--
-- Une valeur lue pour un équipement ou une pièce (numéro de série et fin de
-- garantie d'une chaudière, surface d'une pièce) s'applique à SA fiche par
-- `writeCanonicalEntityField` — jamais à la fiche du bien parent. Il lui faut,
-- comme pour un bien (D-10) :
--
--   · un emplacement pour l'ORIGINE (`<clé>__origin`), la date d'écriture
--     (`<clé>__updatedAt`), l'autorité et la date de la preuve
--     (`__authority`, `__sourceDate`) — sans quoi une valeur saisie par
--     l'utilisateur ne serait pas protégée d'une écriture automatique ;
--   · un emplacement pour les champs SANS colonne : `acquisitionDate`,
--     `lastRevision`, `maintenanceDueDate`, `warrantyStartDate`,
--     `warrantyEndDate` (équipement).
--
--   equipments.key_characteristics  JSONB  fiche canonique de l'équipement ;
--                                    les colonnes `purchase_price_cents`,
--                                    `estimated_value_cents` et
--                                    `equipment_cil_specs.brand / model /
--                                    serial_number / power_kw` en restent les
--                                    MIROIRS (même rôle que pour un bien) ;
--   rooms.key_characteristics       JSONB  idem pour une pièce (`rooms.area`
--                                    miroir de `roomArea`) ;
--   canonical_field_writes.target_type / target_id
--                                    cible d'une ligne du journal 0216 :
--                                    NULL = le bien (`asset_id`) ; EQUIPMENT /
--                                    ROOM + identifiant sinon (`asset_id`
--                                    reste le bien PORTEUR, cloisonnement et
--                                    cascade inchangés).
--
-- Colonnes NON déclarées dans Drizzle (comme 0223 sur `agenda_items`) : des
-- lectures `select()` sans projection existent sur ces tables ; tout passe en
-- SQL après contrôle de présence (`canonical/entity-state/entity-schema.ts`).
-- Absentes : la primitive refuse (SCHEMA_NOT_READY), rien n'est écrit.
--
-- DONNÉES EXISTANTES : défaut constant `'{}'` (valeur de catalogue, AUCUNE
-- réécriture de table, PG ≥ 11) ; journal : colonnes NULL = bien.
-- VERROUS : ADD COLUMN sous ACCESS EXCLUSIVE, bref ; `lock_timeout` 5 s.
-- Dépassé : la migration échoue, est signalée (/api/health) et retentée au
-- démarrage suivant — les écritures d'équipement et de pièce restent refusées.
-- Idempotente : IF NOT EXISTS ; contrainte ajoutée si absente.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE equipments ADD COLUMN IF NOT EXISTS key_characteristics JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE rooms      ADD COLUMN IF NOT EXISTS key_characteristics JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE canonical_field_writes
  ADD COLUMN IF NOT EXISTS target_type TEXT,
  ADD COLUMN IF NOT EXISTS target_id   INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'canonical_field_writes_target_ck'
                    AND conrelid = 'canonical_field_writes'::regclass) THEN
    ALTER TABLE canonical_field_writes
      ADD CONSTRAINT canonical_field_writes_target_ck
      CHECK ((target_type IS NULL AND target_id IS NULL)
          OR (target_type IN ('EQUIPMENT', 'ROOM') AND target_id IS NOT NULL)) NOT VALID;
  END IF;
END $$;

-- Index de l'historique ciblé : 0227_canonical_entity_fields_idx_1.sql (CONCURRENTLY).

COMMENT ON COLUMN equipments.key_characteristics IS
  'Fiche canonique de l''équipement (CDC 15 T1-04, lot 18) : valeurs du registre, <clé>__origin, __updatedAt. Colonnes prix et equipment_cil_specs = miroirs.';
COMMENT ON COLUMN rooms.key_characteristics IS
  'Fiche canonique de la pièce (CDC 15 T1-04, lot 18) : roomArea et son origine ; rooms.area = miroir.';
COMMENT ON COLUMN canonical_field_writes.target_type IS
  'Cible de l''écriture : NULL = le bien asset_id ; EQUIPMENT | ROOM (asset_id = bien porteur).';
