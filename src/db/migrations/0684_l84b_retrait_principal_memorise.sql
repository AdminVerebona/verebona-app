-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0684 : retrait du rôle principal MÉMORISÉ (lot 84, chantier 84B —
-- CDC « Opérations, Agenda, Timeline, Sinistres v5 », lot O-3 : §10, §11.9 ;
-- point ouvert du lot 83A : « quand l'interface permettra de retirer le rôle
-- principal, mémoriser cette décision »).
--
-- La mémoire UNIFIÉE des décisions utilisateur de regroupement (0656 :
-- `business_operation_match_decisions`) est RÉUTILISÉE — aucune table. Son
-- vocabulaire d'objets reçoit :
--   PRINCIPAL  élément d'agenda (`agenda_items.id`) dont l'utilisateur a
--              RETIRÉ le rôle principal (REJECTED) ou qu'il a désigné
--              (CONFIRMED). Tant qu'un retrait est actif sur une Opération,
--              aucune inférence (T4, T3, reprise) n'y désigne ni n'y crée de
--              principal ; une nouvelle désignation par l'utilisateur lève le
--              retrait. Lecture et écriture : service unique
--              `business-operations/grouping/{decisions,service}.ts`.
--
-- Contrainte ÉLARGIE (sur-ensemble strict de 0656, même nom) : aucune ligne
-- existante n'est touchée. Idempotente (rejouable sans effet).
-- Retour arrière : reposer la liste de 0656 (aucune ligne PRINCIPAL ne doit
-- alors subsister).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'business_operation_match_decisions'::regclass
              AND conname = 'business_operation_match_decisions_kind_chk'
              AND pg_get_constraintdef(oid) NOT LIKE '%''PRINCIPAL''::text%') THEN
    ALTER TABLE business_operation_match_decisions DROP CONSTRAINT business_operation_match_decisions_kind_chk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'business_operation_match_decisions'::regclass
                  AND conname = 'business_operation_match_decisions_kind_chk') THEN
    ALTER TABLE business_operation_match_decisions ADD CONSTRAINT business_operation_match_decisions_kind_chk
      CHECK (source_kind IN ('DOCUMENT', 'ASSET_DATA', 'EQUIPMENT_DATA', 'AGENDA', 'CLAIM_FORM', 'USER_ARBITRATION', 'MIGRATION',
                             'ROOM', 'EQUIPMENT', 'PRINCIPAL_LINK', 'PRINCIPAL'));
  END IF;
END $$;
