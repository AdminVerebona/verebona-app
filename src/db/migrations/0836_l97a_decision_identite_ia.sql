-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0836 : origine « AI_IDENTITY » des décisions de rattachement
-- (lot 97A, demande `87B-t3-identite-multi-operations`).
--
-- Une décision T3 d'identité multi-sources VALIDÉE et CERTAINE (contrat
-- `t3-operation-identity-v1`, prompt maître T3 actif) s'applique par le
-- mécanisme EXISTANT de la consolidation T3 : une décision de rattachement
-- `business_operation_match_decisions` (REJECTED : le document ne relève pas
-- de l'Opération ; CONFIRMED : il relève d'une Opération voisine), relue par
-- `decideCandidate`. Son origine `AI_IDENTITY` la distingue d'une décision de
-- l'utilisateur (`USER_ARBITRATION`), de l'exploitation (`ADMIN_REVIEW`) ou
-- d'une référence explicite (`SYSTEM_EXPLICIT_REFERENCE`) : elle n'est jamais
-- comptée comme un choix de l'utilisateur (purge / reconstruction 85A,
-- protections), et une décision de l'utilisateur l'emporte toujours.
--
-- Additive, idempotente : seule la contrainte de vocabulaire est élargie (la
-- liste précédente reste un sous-ensemble). Aucune donnée reprise.
-- Retour arrière : contrainte rétablie sans `AI_IDENTITY` après
-- désactivation des décisions de cette origine (aucune n'existe tant que le
-- PO n'a pas activé la branche OPERATION_IDENTITY du prompt T3).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'business_operation_match_decisions'::regclass
              AND conname = 'business_operation_match_decisions_origin_chk' AND pg_get_constraintdef(oid) NOT LIKE '%AI_IDENTITY%') THEN
    ALTER TABLE business_operation_match_decisions DROP CONSTRAINT business_operation_match_decisions_origin_chk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'business_operation_match_decisions'::regclass
                  AND conname = 'business_operation_match_decisions_origin_chk') THEN
    ALTER TABLE business_operation_match_decisions ADD CONSTRAINT business_operation_match_decisions_origin_chk
      CHECK (origin IN ('USER_ARBITRATION', 'SYSTEM_EXPLICIT_REFERENCE', 'ADMIN_REVIEW', 'AI_IDENTITY'));
  END IF;
END $$;
