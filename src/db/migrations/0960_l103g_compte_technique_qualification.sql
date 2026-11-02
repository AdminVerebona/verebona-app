-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0960 : compte technique de qualification IA (lot 103G, ticket P1
-- « compte technique de qualification »). Service :
-- `src/services/ai/qualification/technical-account.ts`.
--
--   · accounts.technical_kind : marqueur d'identité technique FIABLE en base.
--       NULL                       tout compte client (cas général) ;
--       'AI_QUALIFICATION_CORPUS'  le compte de mesure du corpus (au plus un :
--                                  index unique partiel 0960_…_idx_1 + verrou
--                                  consultatif au provisionnement).
--     Les exemptions (éligibilité C-Q10, plafond de coût) n'existent plus que
--     pour CE compte marqué, dans le contexte serveur d'une campagne : plus
--     jamais sur la seule égalité avec CORPUS_ACCOUNT_ID.
--   · Marquage du compte technique EXISTANT (créé par le seed ou la route
--     corpus-account) : identité dédiée corpus@verebona.local, utilisateur
--     inactif, mot de passe marqueur « ! », aucun abonnement ni Stripe, seul
--     compte de son titulaire, et aucun compte déjà marqué. Un compte client
--     n'est jamais marqué.
--   · ai_prompt_conformity_issues.prerequisite : blocage par un PRÉREQUIS
--     d'exploitation (compte technique) distinct d'un refus de non-régression,
--     et historique borné des reprises automatiques ({} : aucun).
--
-- Additive et idempotente (colonnes nullables / défaut constant : aucune
-- réécriture de table). Retour arrière : ALTER TABLE accounts DROP COLUMN
-- technical_kind ; ALTER TABLE ai_prompt_conformity_issues DROP COLUMN
-- prerequisite (le compte technique n'est alors plus reconnu : campagnes
-- refusées, à éviter).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS technical_kind TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'accounts'::regclass AND conname = 'accounts_technical_kind_chk') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_technical_kind_chk
      CHECK (technical_kind IS NULL OR technical_kind IN ('AI_QUALIFICATION_CORPUS')) NOT VALID;
  END IF;
END $$;

UPDATE accounts a
   SET technical_kind = 'AI_QUALIFICATION_CORPUS'
  FROM users u
 WHERE u.id = a.owner_user_id
   AND lower(u.email) = 'corpus@verebona.local'
   AND u.is_active = false
   AND u.role = 'USER'
   AND COALESCE(u.password_hash LIKE '!%', false)
   AND a.technical_kind IS NULL
   AND a.subscription_status = 'NONE'
   AND a.stripe_customer_id IS NULL
   AND a.stripe_subscription_id IS NULL
   AND (SELECT count(*) FROM accounts a2 WHERE a2.owner_user_id = u.id) = 1
   AND NOT EXISTS (SELECT 1 FROM accounts x WHERE x.technical_kind = 'AI_QUALIFICATION_CORPUS');

ALTER TABLE IF EXISTS ai_prompt_conformity_issues ADD COLUMN IF NOT EXISTS prerequisite JSONB NOT NULL DEFAULT '{}'::jsonb;
