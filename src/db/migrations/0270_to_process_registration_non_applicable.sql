-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0270 : cartes « À traiter » d'immatriculation sans objet — lot 32
-- (ticket L32-1, « Vélo Jean Fourche — RK469970GP »).
--
-- Un vélo (et toute catégorie Véhicule non motorisée : VTT, trottinette) n'a
-- pas d'immatriculation : la règle DATA-REGISTRATION n'aurait jamais dû y
-- ouvrir de carte. Le producteur est corrigé dans le code
-- (`isFieldApplicableToAsset`, capacité `registration`) ; les cartes OUVERTES
-- déjà produites — sur ces catégories, ou sur un bien qui n'est pas un
-- véhicule — sont fermées (OBSOLETE) et tracées (`to_process_action_events`,
-- motif FIELD_NOT_APPLICABLE). Les cartes fermées ne sont pas touchées.
--
-- Même liste que `UNREGISTERED_VEHICLE_CATEGORIES` (`lib/asset-capabilities`),
-- comparée sans casse ni accents. Le balayage horaire (`to-process-scan`)
-- applique ensuite la même règle à tout changement de catégorie.
--
-- Idempotente (plus rien à faire au second passage). `lock_timeout` borne
-- l'attente ; `SET LOCAL` : une transaction implicite (multi-instructions).
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

WITH sans_objet AS (
  UPDATE to_process_actions a
     SET resolved_at = now(), resolution_reason = 'OBSOLETE', updated_at = now()
    FROM assets b
   WHERE a.resolved_at IS NULL
     AND a.target_type = 'ASSET'
     AND a.field_key IN ('registrationNumber', 'registrationExpiry', 'firstRegistrationDate')
     AND b.id = a.target_id
     AND b.account_id = a.account_id
     AND (
       upper(trim(coalesce(b.category, ''))) <> 'VEHICULE'
       OR translate(lower(trim(coalesce(b.subtype, ''))), 'éèêë', 'eeee') IN ('velo', 'vtt', 'trottinette')
     )
  RETURNING a.id, a.account_id, a.target_id, a.field_key, a.rule_code
)
INSERT INTO to_process_action_events (action_id, account_id, event, target_type, target_id, field_key, details)
SELECT id, account_id, 'OBSOLETE', 'ASSET', target_id, field_key,
       jsonb_build_object('ruleCode', rule_code, 'reason', 'FIELD_NOT_APPLICABLE', 'migration', '0270')
  FROM sans_objet;
