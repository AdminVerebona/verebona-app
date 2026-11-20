-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1830 : MÉMOIRE DURABLE D'UNE SCISSION (lot 116C, carte Trello #806,
-- §4 « Scissions, T3 et cohérence du graphe » ; CDC « Opérations / Agenda V2.0 »
-- §7 ; AC46).
--
-- DÉCISION DU PO (carte #806) : une scission MANUELLE interdit durablement toute
-- refusion AUTOMATIQUE des deux opérations, même après l'arrivée de nouvelles
-- preuves. Une refusion n'a lieu que sur décision explicite de l'utilisateur.
--
-- AVANT : la mémoire de la séparation était le seul MOTIF de la relation gardée
-- entre les deux opérations (`business_operation_relations.reason_code =
-- 'USER_SPLIT'`). Or ce motif est RÉÉCRIT par tout changement ultérieur de la
-- relation (dissociation, nouvelle association, report lors d'une fusion) : la
-- mémoire pouvait donc se perdre, et la séparation redevenir « fusionnable ».
--
-- CIBLE : deux colonnes sur la relation, posées par la scission et que PLUS
-- AUCUNE écriture ne retire :
--   · `split_apart_at`           horodatage de la scission décidée par
--                                l'utilisateur (NULL : jamais scindées) ;
--   · `split_apart_by_user_id`   son auteur (effacé avec l'utilisateur).
-- La relation suit déjà ses deux opérations (fusion : `reassignGraphOnMerge`,
-- qui reporte désormais aussi cette mémoire ; transfert d'un bien entre comptes :
-- `detachCrossAccountGraphInTx`). Aucune table nouvelle.
--
-- REPRISE déterministe, rejouable, sans décision nouvelle :
--   a. les relations qui portent ENCORE le motif `USER_SPLIT` ;
--   b. les relations dont le motif a été réécrit depuis, retrouvées par le
--      journal du graphe (ligne `CREATED` de motif `USER_SPLIT`, même compte,
--      même paire) — le journal est en ajout seul, il n'est pas modifié.
-- Aucune relation n'est créée, retirée ni réactivée ; aucun état ne change.
--
-- Additive, idempotente, rejouable. Retour arrière : DROP INDEX
-- business_operation_relations_split_apart_idx ; ALTER TABLE
-- business_operation_relations DROP COLUMN split_apart_at, DROP COLUMN
-- split_apart_by_user_id (aucune lecture antérieure au lot 116C n'en dépend).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE business_operation_relations ADD COLUMN IF NOT EXISTS split_apart_at TIMESTAMPTZ;
ALTER TABLE business_operation_relations ADD COLUMN IF NOT EXISTS split_apart_by_user_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_relations_split_user_fk') THEN
    ALTER TABLE business_operation_relations ADD CONSTRAINT business_operation_relations_split_user_fk
      FOREIGN KEY (split_apart_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- a. Motif encore en place.
UPDATE business_operation_relations
   SET split_apart_at = COALESCE(decided_at, created_at, now()),
       split_apart_by_user_id = decided_by_user_id
 WHERE reason_code = 'USER_SPLIT' AND split_apart_at IS NULL;

-- b. Motif réécrit depuis : la scission est retrouvée dans le journal du graphe.
UPDATE business_operation_relations rel
   SET split_apart_at = h.created_at,
       split_apart_by_user_id = h.actor_user_id
  FROM (
    SELECT DISTINCT ON (account_id, LEAST(operation_id, other_operation_id), GREATEST(operation_id, other_operation_id))
           account_id, LEAST(operation_id, other_operation_id) AS a, GREATEST(operation_id, other_operation_id) AS b,
           created_at, actor_user_id
      FROM business_operation_graph_history
     WHERE relation_kind = 'OPERATION_RELATION' AND action = 'CREATED' AND reason_code = 'USER_SPLIT'
       AND other_operation_id IS NOT NULL
     ORDER BY account_id, LEAST(operation_id, other_operation_id), GREATEST(operation_id, other_operation_id), id
  ) h
 WHERE rel.split_apart_at IS NULL AND rel.account_id = h.account_id
   AND LEAST(rel.from_operation_id, rel.to_operation_id) = h.a
   AND GREATEST(rel.from_operation_id, rel.to_operation_id) = h.b;

-- Lecture de la porte unique des fusions automatiques : paires scindées d'un compte.
CREATE INDEX IF NOT EXISTS business_operation_relations_split_apart_idx
  ON business_operation_relations (account_id) WHERE split_apart_at IS NOT NULL;
