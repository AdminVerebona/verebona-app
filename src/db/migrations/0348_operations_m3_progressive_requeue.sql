-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0348 : reprise des rapprochements T3 laissés sans tentative
-- (lot 53C — retour PO D7, « jamais d'abandon permanent du rapprochement »).
--
-- Jusqu'au lot 52, un candidat T1 en attente « M3_REQUIRED » avec PLUS de 5
-- Opérations plausibles n'était jamais soumis au rapprochement sémantique :
-- pas d'empreinte de contexte (`t3_detail.m3Fingerprint`), ou trace
-- `t3_detail.m3.status = 'TOO_MANY_CANDIDATES'` jamais reprise. Le lot 53
-- examine ces candidats par lots classés de 5 (examen progressif) : ils sont
-- remis en consolidation (`t3_pending`), le balayage horaire T3 (tâche
-- planifiée interne) les reprend sans aucune action d'exploitation.
--
-- Données seulement (aucun changement de schéma). Bornée aux candidats ACTIFS
-- concernés ; idempotente (une seconde exécution ne trouve plus rien : la
-- consolidation pose l'empreinte du lot courant). Retour arrière : sans objet
-- (le marqueur `t3_pending` est levé par le passage T3 suivant).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

UPDATE document_operation_candidates
   SET t3_pending = true
 WHERE status = 'ACTIVE'
   AND NOT t3_pending
   AND t3_outcome = 'HOLD_UNRESOLVED'
   AND t3_reason = 'M3_REQUIRED'
   AND (NOT (COALESCE(t3_detail, '{}'::jsonb) ? 'm3Fingerprint')
        OR t3_detail->'m3'->>'status' = 'TOO_MANY_CANDIDATES');
