-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0107 : Origine structurée des champs — CDC §6.2
--
-- Convertit `<champ>_origin = 'auto' | 'manual'` en `<champ>__origin` portant
-- l'une des six origines cibles. Les deux formats coexistent pendant la
-- transition : `field-origin.ts` lit l'ancien si le nouveau est absent.
--
-- ⚠️ POINT LE PLUS RISQUÉ DE LA MIGRATION. Une erreur d'interprétation revient
-- à traiter une saisie utilisateur comme une valeur automatique, donc à
-- autoriser son écrasement. En cas de doute, la lecture applicative suppose
-- `USER` — le format le plus protecteur.
--
-- La migration est IDEMPOTENTE et n'écrase jamais une clé `__origin` existante.
-- ──────────────────────────────────────────────────────────────────────────────

-- Table de contrôle : permet de vérifier la complétude avant bascule et de
-- revenir en arrière si un écart est constaté.
CREATE TABLE IF NOT EXISTS field_origin_migration_audit (
  id             SERIAL PRIMARY KEY,
  asset_id       INTEGER     NOT NULL,
  account_id     INTEGER     NOT NULL,
  field_key      TEXT        NOT NULL,
  legacy_value   TEXT        NOT NULL,
  migrated_value TEXT        NOT NULL,
  migrated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS field_origin_migration_audit_asset_idx
  ON field_origin_migration_audit(asset_id);

DO $$
DECLARE
  rec        RECORD;
  kc         JSONB;
  next_kc    JSONB;
  legacy_key TEXT;
  field_key  TEXT;
  legacy_val TEXT;
  new_val    TEXT;
  changed    BOOLEAN;
BEGIN
  FOR rec IN
    SELECT id, account_id, key_characteristics
      FROM assets
     WHERE key_characteristics IS NOT NULL
       AND deleted_at IS NULL
  LOOP
    BEGIN
      kc := rec.key_characteristics::jsonb;
    EXCEPTION WHEN others THEN
      CONTINUE;  -- JSON invalide : laissé en l'état, traité applicativement
    END;

    next_kc := kc;
    changed := FALSE;

    FOR legacy_key IN SELECT jsonb_object_keys(kc) LOOP
      CONTINUE WHEN legacy_key NOT LIKE '%\_origin';
      CONTINUE WHEN legacy_key LIKE '%\_\_origin';

      field_key  := left(legacy_key, length(legacy_key) - length('_origin'));
      legacy_val := kc ->> legacy_key;

      -- Ne jamais écraser une origine déjà au format cible.
      CONTINUE WHEN kc ? (field_key || '__origin');

      new_val := CASE legacy_val
        WHEN 'auto'   THEN 'DOCUMENT_EXTRACTION'
        WHEN 'manual' THEN 'USER'
        ELSE NULL
      END;

      CONTINUE WHEN new_val IS NULL;  -- valeur inconnue : on protège

      next_kc := next_kc || jsonb_build_object(field_key || '__origin', new_val);
      changed := TRUE;

      INSERT INTO field_origin_migration_audit
        (asset_id, account_id, field_key, legacy_value, migrated_value)
      VALUES (rec.id, rec.account_id, field_key, legacy_val, new_val);
    END LOOP;

    IF changed THEN
      UPDATE assets SET key_characteristics = next_kc::text WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;

-- Les clés `_origin` historiques sont CONSERVÉES : leur suppression interviendra
-- au lot 7, après la période de stabilité (§10.3).
