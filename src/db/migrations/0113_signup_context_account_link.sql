-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0113 — Rattachement du contexte d'inscription au compte créé
--
-- POURQUOI
--
-- Le CDC parrainage §4.3 autorise explicitement le transport du code « dans une
-- donnée transmise directement au serveur lors de la création du compte », et
-- le §4.5 cite « création effective du compte » en premier parmi les moments
-- où l'enregistrement en base est justifié.
--
-- La table `signup_contexts` (migration 0071) était prévue pour cela, mais :
--   • aucune ligne du code ne l'écrit ni ne la lit ;
--   • elle ne porte ni `user_id` ni `account_id`, donc rien ne permet de
--     retrouver le contexte d'un inscrit.
--
-- Résultat : le code de parrainage saisi au formulaire n'allait nulle part.
-- L'attribution se fait au checkout, à partir du corps de la requête — mais
-- l'inscription et la souscription sont séparées par une vérification d'email
-- et jusqu'à sept jours d'essai. Aucun parrainage ne pouvait aboutir.
--
-- Cette migration ne change pas la règle commerciale : l'avantage reste acquis
-- à la souscription d'un abonnement annuel, après le délai de rétractation
-- (CDC tarification §13). Elle rend seulement l'attribution *mémorisable*
-- entre les deux moments.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE signup_contexts
  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE signup_contexts
  ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS signup_contexts_user_id_idx
  ON signup_contexts (user_id);

CREATE INDEX IF NOT EXISTS signup_contexts_account_id_idx
  ON signup_contexts (account_id);

-- Un inscrit, un contexte. Rend l'écriture idempotente (`ON CONFLICT DO
-- NOTHING`) : une double soumission du formulaire ne crée pas deux attributions.
-- Index partiel : les contextes anonymes historiques, sans `user_id`, restent
-- possibles et ne se gênent pas entre eux.
CREATE UNIQUE INDEX IF NOT EXISTS signup_contexts_user_uidx
  ON signup_contexts (user_id)
  WHERE user_id IS NOT NULL;

COMMENT ON COLUMN signup_contexts.user_id IS
  'Inscrit auquel ce contexte se rapporte. NULL pour un contexte anonyme.';
COMMENT ON COLUMN signup_contexts.account_id IS
  'Compte créé lors de cette inscription. NULL pour une arrivée par invitation.';
