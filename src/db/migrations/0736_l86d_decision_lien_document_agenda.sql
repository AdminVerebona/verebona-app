-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0736 : décision de l'utilisateur sur UN lien Document ↔ Agenda
-- (lot 86, chantier 86D — ticket P1 « Documents / Agenda — associations
-- erronées et gestion bidirectionnelle » : §2, §4, §5).
--
-- La mémoire UNIFIÉE des décisions de regroupement (0656 / 0684 :
-- `business_operation_match_decisions`) est RÉUTILISÉE — aucune table. Son
-- vocabulaire d'objets reçoit :
--   AGENDA_FILE_LINK  couple (élément d'agenda, document), clé
--                     `<agenda_items.id>:<asset_files.id>` :
--                       REJECTED  l'utilisateur a DÉTACHÉ ce document de cet
--                                 élément — aucun traitement automatique (T4,
--                                 propagation vers l'événement de référence,
--                                 consolidation 76H, reprise) ne recrée le lien ;
--                       CONFIRMED l'utilisateur a relié ce document à cet
--                                 élément (lève un détachement antérieur).
--
-- Cette décision porte sur le LIEN, pas sur un regroupement : un élément
-- d'agenda peut n'appartenir à aucun ensemble. `candidate_operation_id` devient
-- donc facultatif — NUL pour AGENDA_FILE_LINK et seulement pour lui (contrainte
-- `business_operation_match_decisions_scope_chk`). Les lectures existantes
-- filtrent toutes par Opération : elles ne voient jamais ces lignes ; la
-- fusion d'Opérations (remappage par `candidate_operation_id`) et la purge /
-- reconstruction (cascade par Opération) ne les touchent pas — la décision
-- survit.
--
-- Unicité d'une décision active par lien : index partiel unique (fichier
-- _idx_1, construit sans bloquer) ; écriture par le service unique (verrou
-- 39101 du compte).
--
-- Contraintes ÉLARGIES (sur-ensemble strict de 0684, même nom) : aucune ligne
-- existante n'est touchée (toutes portent une Opération). Idempotente.
-- Retour arrière (aucune ligne AGENDA_FILE_LINK ne doit subsister) :
--   DELETE FROM business_operation_match_decisions WHERE source_kind = 'AGENDA_FILE_LINK';
--   ALTER TABLE business_operation_match_decisions DROP CONSTRAINT business_operation_match_decisions_scope_chk;
--   ALTER TABLE business_operation_match_decisions ALTER COLUMN candidate_operation_id SET NOT NULL;
--   puis reposer la liste de 0684.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE business_operation_match_decisions ALTER COLUMN candidate_operation_id DROP NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'business_operation_match_decisions'::regclass
              AND conname = 'business_operation_match_decisions_kind_chk'
              AND pg_get_constraintdef(oid) NOT LIKE '%AGENDA_FILE_LINK%') THEN
    ALTER TABLE business_operation_match_decisions DROP CONSTRAINT business_operation_match_decisions_kind_chk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'business_operation_match_decisions'::regclass
                  AND conname = 'business_operation_match_decisions_kind_chk') THEN
    ALTER TABLE business_operation_match_decisions ADD CONSTRAINT business_operation_match_decisions_kind_chk
      CHECK (source_kind IN ('DOCUMENT', 'ASSET_DATA', 'EQUIPMENT_DATA', 'AGENDA', 'CLAIM_FORM', 'USER_ARBITRATION', 'MIGRATION',
                             'ROOM', 'EQUIPMENT', 'PRINCIPAL_LINK', 'PRINCIPAL', 'AGENDA_FILE_LINK'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'business_operation_match_decisions'::regclass
                  AND conname = 'business_operation_match_decisions_scope_chk') THEN
    ALTER TABLE business_operation_match_decisions ADD CONSTRAINT business_operation_match_decisions_scope_chk
      CHECK ((source_kind = 'AGENDA_FILE_LINK') = (candidate_operation_id IS NULL));
  END IF;
END $$;
