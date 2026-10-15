-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0401 : arbitrages Documents → Opérations (lot 56A, ticket P1
-- « Supprimer les arbitrages inutiles grâce à l'IA et corriger le libellé de
-- confirmation »).
--
--   1. Libellés des questions ENCORE OUVERTES (« À traiter », desktop et
--      mobile lisent les mêmes propositions) :
--        · OPERATION-MATCH : « Oui, la même » → « Oui » ;
--        · OPERATION-CLAIM-ASSET : « Non, il reste hors du sinistre » →
--          « Non, pas de nouveau rattachement au sinistre ».
--      Seul le libellé change (valeur de la proposition inchangée : une
--      réponse en cours reste valide). Les cartes résolues ne sont pas
--      touchées (historique).
--   2. Questions « même réalité ? » ouvertes issues d'un verdict IA incertain
--      (ARBITRATION_REQUIRED / M3_AMBIGUOUS) : le document est MARQUÉ pour le
--      passage T3 existant (balayage horaire interne) — il est réexaminé avec
--      le nouveau contexte IA (unités documentaires T1) et la question est
--      fermée d'elle-même si l'IA rattache désormais le document ; sinon elle
--      reste posée. Plafonds d'appels IA inchangés (5 par passage, 30 par jour
--      et par compte). Aucune donnée métier n'est modifiée ici ; une décision
--      utilisateur n'est jamais concernée (la carte répondue n'est plus une
--      question ouverte).
--
-- Idempotente (marque `reexamen0401` posée une seule fois ; libellés déjà
-- corrigés ignorés). Isolation : chaque ligne reste dans son compte.
-- Retour arrière : aucun nécessaire (libellés ; marque de travail consommée
-- comme un réexamen ordinaire).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

UPDATE to_process_actions a
   SET proposals_json = (
         SELECT jsonb_agg(
                  CASE
                    WHEN a.rule_code = 'OPERATION-MATCH' AND e->>'label' = 'Oui, la même' THEN jsonb_set(e, '{label}', '"Oui"')
                    WHEN a.rule_code = 'OPERATION-CLAIM-ASSET' AND e->>'label' = 'Non, il reste hors du sinistre'
                      THEN jsonb_set(e, '{label}', '"Non, pas de nouveau rattachement au sinistre"')
                    ELSE e
                  END ORDER BY i)
           FROM jsonb_array_elements(a.proposals_json) WITH ORDINALITY AS t(e, i)),
       updated_at = now()
 WHERE a.resolved_at IS NULL
   AND a.rule_code IN ('OPERATION-MATCH', 'OPERATION-CLAIM-ASSET')
   AND jsonb_typeof(a.proposals_json) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.proposals_json) e
                WHERE e->>'label' IN ('Oui, la même', 'Non, il reste hors du sinistre'));

UPDATE document_operation_candidates c
   SET t3_pending = true,
       t3_detail = COALESCE(c.t3_detail, '{}'::jsonb) || jsonb_build_object('reexamen0401', now())
 WHERE c.status = 'ACTIVE' AND NOT c.t3_pending
   AND c.t3_outcome = 'ARBITRATION_REQUIRED' AND c.t3_reason = 'M3_AMBIGUOUS'
   AND NOT (COALESCE(c.t3_detail, '{}'::jsonb) ? 'reexamen0401');
