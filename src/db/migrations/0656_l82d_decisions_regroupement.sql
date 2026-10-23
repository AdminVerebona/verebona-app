-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0656 : mémoire UNIFIÉE des décisions utilisateur de regroupement
-- (lot 82, chantier 82D — CDC v5 O-1 : §10, E18, P8).
--
-- La mémoire existante `business_operation_match_decisions` (C6.3, lot 42 :
-- décisions CONFIRMED / REJECTED d'un objet pour une Opération, remappées à
-- la fusion, respectées par T3 en M0) est RÉUTILISÉE — aucune nouvelle
-- table. Son vocabulaire d'objets est étendu aux objets du regroupement v5 :
--   ROOM            Pièce (`substructures.id`) rattachée / retirée ;
--   EQUIPMENT       équipement (`equipments.id`) rattaché / retiré ;
--   PRINCIPAL_LINK  lien propagé document (`asset_files.id`) → élément
--                   principal de l'Opération, retiré par l'utilisateur : la
--                   propagation (§7.1) ne le recrée plus.
-- (DOCUMENT et AGENDA existaient déjà ; les biens gardent leur mémoire
-- d'exclusion 0349.) Lecture et écriture : service unique
-- `business-operations/grouping/decisions.ts`.
--
-- Contrainte ÉLARGIE (sur-ensemble strict de l'ancienne, même nom, comme
-- 0609 pour l'origine) : aucune ligne existante n'est touchée. Idempotente.
-- Retour arrière : reposer la liste de 0317 (aucune ligne des nouveaux types
-- ne doit alors subsister).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'business_operation_match_decisions'::regclass
              AND conname = 'business_operation_match_decisions_kind_chk' AND pg_get_constraintdef(oid) NOT LIKE '%PRINCIPAL_LINK%') THEN
    ALTER TABLE business_operation_match_decisions DROP CONSTRAINT business_operation_match_decisions_kind_chk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'business_operation_match_decisions'::regclass
                  AND conname = 'business_operation_match_decisions_kind_chk') THEN
    ALTER TABLE business_operation_match_decisions ADD CONSTRAINT business_operation_match_decisions_kind_chk
      CHECK (source_kind IN ('DOCUMENT', 'ASSET_DATA', 'EQUIPMENT_DATA', 'AGENDA', 'CLAIM_FORM', 'USER_ARBITRATION', 'MIGRATION',
                             'ROOM', 'EQUIPMENT', 'PRINCIPAL_LINK'));
  END IF;
END $$;
