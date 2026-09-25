-- 0160 — Retrait de l'attribut « Bien mis en location » (assets.is_rented).
--
-- L'attribut doublonnait le champ Usage de la section « Occupation / usage »,
-- dont le choix « Locatif » (désormais libellé « Mis en location ») dit la
-- même chose. L'usage devient la seule source.
--
-- 1. Report : un bien déclaré loué SANS usage renseigné reçoit l'usage
--    LOCATIF. Un usage déjà saisi n'est JAMAIS écrasé (la fiche fait foi) ;
--    les biens concernés sont seulement comptés.
-- 2. Les actions « À traiter » ouvertes sur l'attribut deviennent obsolètes :
--    elles porteraient sur une donnée qui n'existe plus à l'écran.
-- 3. Les colonnes is_rented* sont conservées (non lues, non écrites) pour
--    permettre un retour arrière ; leur suppression physique fera l'objet
--    d'une migration ultérieure, une fois le report vérifié en production.

DO $$
DECLARE
  r RECORD;
  kc JSONB;
  reportes INT := 0;
  conserves INT := 0;
  invalides INT := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'assets' AND column_name = 'is_rented'
  ) THEN
    RETURN;
  END IF;

  FOR r IN
    EXECUTE 'SELECT id, key_characteristics FROM assets WHERE is_rented = TRUE AND deleted_at IS NULL'
  LOOP
    BEGIN
      kc := coalesce(nullif(btrim(coalesce(r.key_characteristics, '')), ''), '{}')::jsonb;
      IF jsonb_typeof(kc) <> 'object' THEN
        invalides := invalides + 1;
        CONTINUE;
      END IF;
      IF coalesce(kc->>'occupancyUsage', '') = '' THEN
        UPDATE assets
           SET key_characteristics = (kc || jsonb_build_object('occupancyUsage', 'LOCATIF'))::text,
               updated_at = now()
         WHERE id = r.id;
        reportes := reportes + 1;
      ELSIF kc->>'occupancyUsage' <> 'LOCATIF' THEN
        conserves := conserves + 1;
      END IF;
    EXCEPTION WHEN others THEN
      -- Caractéristiques au JSON invalide : rien n'est réécrit.
      invalides := invalides + 1;
    END;
  END LOOP;

  RAISE NOTICE '0160 : % bien(s) reporté(s) en usage LOCATIF, % usage(s) différent(s) conservé(s), % caractéristique(s) illisible(s)',
    reportes, conserves, invalides;
END $$;

UPDATE to_process_actions
   SET resolved_at = now(), resolution_reason = 'OBSOLETE', updated_at = now()
 WHERE target_type = 'ASSET' AND field_key = 'isRented' AND resolved_at IS NULL;

COMMENT ON COLUMN assets.is_rented IS
  'OBSOLÈTE (0160) : remplacé par key_characteristics.occupancyUsage = LOCATIF. Ni lu ni écrit.';
