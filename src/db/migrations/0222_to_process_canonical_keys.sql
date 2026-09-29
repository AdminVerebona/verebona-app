-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0222 : cartes « À traiter » sur les clés canoniques (CDC 15 X-03,
-- lot 13).
--
-- La règle DATA-ACQUISITION-PRICE porte désormais la clé canonique
-- `acquisitionPrice` (registre) ; les cartes OUVERTES créées sous l'ancienne
-- clé `purchasePriceCents` (seul alias qu'une règle de bien ait porté —
-- `registrationNumber` était déjà canonique) sont alignées :
--   · s'il existe déjà une carte ouverte `acquisitionPrice` pour le même
--     compte et le même bien, l'ancienne est FERMÉE (OBSOLETE, historisée) —
--     l'index d'unicité 0147 (un problème actif par donnée) interdit de la
--     renommer ;
--   · sinon, elle est renommée (`field_key`) : même problème, même carte.
-- Les propositions éventuelles sont rafraîchies par la réconciliation
-- suivante (upsert sur la clé canonique). Les cartes fermées ne sont pas
-- touchées (historique).
--
-- Idempotente (plus rien à faire au second passage). `lock_timeout` borne
-- l'attente ; `SET LOCAL` : une transaction implicite (multi-instructions).
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

UPDATE to_process_actions a
   SET resolved_at = now(), resolution_reason = 'OBSOLETE', updated_at = now()
 WHERE a.resolved_at IS NULL
   AND a.target_type = 'ASSET'
   AND a.field_key = 'purchasePriceCents'
   AND EXISTS (
     SELECT 1 FROM to_process_actions c
      WHERE c.resolved_at IS NULL
        AND c.account_id = a.account_id AND c.target_type = a.target_type AND c.target_id = a.target_id
        AND c.field_key = 'acquisitionPrice');

UPDATE to_process_actions
   SET field_key = 'acquisitionPrice', updated_at = now()
 WHERE resolved_at IS NULL
   AND target_type = 'ASSET'
   AND field_key = 'purchasePriceCents';
