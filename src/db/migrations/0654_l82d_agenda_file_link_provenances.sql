-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0654 : provenance des liens Document ↔ Agenda (lot 82, chantier
-- 82D — CDC v5 O-1 : §7.4, §11.9, E07 ; invariant INV-O1-PROVENANCE).
--
--   agenda_file_links.provenances   ensemble des JUSTIFICATIONS du lien :
--     MANUAL_DIRECT        lien posé par l'utilisateur (agenda manuel) ;
--     AI_DIRECT            lien posé par un traitement (T4 depuis le document,
--                          projection d'une échéance) ;
--     OPERATION_PRINCIPAL  propagation : document membre de l'Opération dont
--                          l'élément est le principal (§7.1, P4).
--   Une relation physique n'est supprimée que lorsqu'AUCUNE provenance ne la
--   justifie plus (service `business-operations/grouping/provenance.ts`).
--   Le même lien peut cumuler plusieurs provenances (§7.3 : la propagation ne
--   remplace jamais un lien précis).
--
-- REPRISE DÉTERMINISTE des liens existants (aucune décision nouvelle) :
--   élément projeté (`projection_origin = 'OPERATION'`) principal de son
--   Opération → OPERATION_PRINCIPAL (la projection y recopiait les documents
--   de l'Opération) ; autre élément projeté ou élément automatique → AI_DIRECT ;
--   sinon (élément saisi) → MANUAL_DIRECT.
--
-- Ajout de colonne avec défaut constant : instantané (aucune réécriture).
-- Contrainte NOT VALID puis validée dans le même fichier (table de liens,
-- parcours bref). Idempotente (reprise limitée aux lignes sans provenance).
-- Retour arrière : ALTER TABLE agenda_file_links DROP CONSTRAINT
-- agenda_file_links_provenances_check, DROP COLUMN provenances.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE agenda_file_links ADD COLUMN IF NOT EXISTS provenances TEXT[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agenda_file_links_provenances_check' AND conrelid = 'agenda_file_links'::regclass) THEN
    ALTER TABLE agenda_file_links ADD CONSTRAINT agenda_file_links_provenances_check
      CHECK (provenances <@ ARRAY['MANUAL_DIRECT', 'AI_DIRECT', 'OPERATION_PRINCIPAL']::text[]) NOT VALID;
  END IF;
END $$;

UPDATE agenda_file_links l
   SET provenances = CASE
         WHEN i.projection_origin = 'OPERATION' AND i.operation_role = 'PRINCIPAL' THEN ARRAY['OPERATION_PRINCIPAL']::text[]
         WHEN i.projection_origin = 'OPERATION' OR i.is_automatic THEN ARRAY['AI_DIRECT']::text[]
         ELSE ARRAY['MANUAL_DIRECT']::text[] END
  FROM agenda_items i
 WHERE i.id = l.agenda_item_id AND cardinality(l.provenances) = 0;

ALTER TABLE agenda_file_links VALIDATE CONSTRAINT agenda_file_links_provenances_check;
