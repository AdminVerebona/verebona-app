-- =============================================================================
-- 0151 — Conversations de l'assistant privées par utilisateur (Duo).
--
-- Jusqu'ici : « 1 conversation active par compte », historique partagé entre
-- les membres d'un compte Duo. Désormais une conversation appartient à un
-- COUPLE compte + utilisateur, et ce cloisonnement est porté par la base :
--   · colonne verebona_conversations.user_id (NOT NULL) ;
--   · unicité de la conversation active par (account_id, user_id) ;
--   · idempotence des messages par (account_id, author_user_id, client_request_id).
--
-- REPRISE DE L'EXISTANT
--   Une conversation Duo existante peut contenir les questions des DEUX
--   membres. Elle est scindée : chaque auteur récupère ses questions et les
--   réponses qui leur correspondent (même request_id), dans une conversation
--   à son nom. Une clarification en attente sur une conversation scindée est
--   abandonnée (on ne sait pas à qui elle s'adressait ; elle expire en 30 min).
--   Les conversations sans aucune question identifiable sont supprimées.
--
-- Idempotente : relancée, elle ne rescinde rien (user_id déjà posé).
-- =============================================================================

ALTER TABLE verebona_conversations ADD COLUMN IF NOT EXISTS user_id INTEGER;

-- L'ancienne unicité par compte empêcherait la scission ci-dessous.
DROP INDEX IF EXISTS verebona_conversations_active_account_uidx;

-- 1. Propriétaire = premier auteur d'une question.
UPDATE verebona_conversations c
   SET user_id = (
     SELECT m.author_user_id
       FROM verebona_messages m
      WHERE m.conversation_id = c.id AND m.role = 'user' AND m.author_user_id IS NOT NULL
      ORDER BY m.created_at, m.id
      LIMIT 1)
 WHERE c.user_id IS NULL;

-- 2. Scission des conversations partagées : un fil par auteur supplémentaire.
DO $$
DECLARE
  r RECORD;
  nouvelle INTEGER;
BEGIN
  FOR r IN
    SELECT DISTINCT m.conversation_id, m.author_user_id
      FROM verebona_messages m
      JOIN verebona_conversations c ON c.id = m.conversation_id
     WHERE m.role = 'user'
       AND m.author_user_id IS NOT NULL
       AND m.author_user_id <> c.user_id
  LOOP
    INSERT INTO verebona_conversations
      (account_id, user_id, status, machine_state, context_json, clarification_state_json,
       locale, created_at, updated_at, expires_at)
    SELECT account_id, r.author_user_id, status, 'IDLE', '{}'::jsonb, NULL,
           locale, created_at, updated_at, expires_at
      FROM verebona_conversations WHERE id = r.conversation_id
    RETURNING id INTO nouvelle;

    -- Réponses de l'assistant : rattachées par request_id à la question.
    UPDATE verebona_messages
       SET conversation_id = nouvelle
     WHERE conversation_id = r.conversation_id
       AND (author_user_id = r.author_user_id
            OR (role <> 'user' AND request_id IN (
                  SELECT request_id FROM verebona_messages
                   WHERE conversation_id = r.conversation_id
                     AND author_user_id = r.author_user_id
                     AND request_id IS NOT NULL)));

    UPDATE verebona_request_runs
       SET conversation_id = nouvelle
     WHERE conversation_id = r.conversation_id AND user_id = r.author_user_id;

    UPDATE verebona_conversations
       SET clarification_state_json = NULL, context_json = '{}'::jsonb
     WHERE id = r.conversation_id;
  END LOOP;
END $$;

-- 3. Conversations sans propriétaire identifiable : rien à rattacher.
DELETE FROM verebona_conversations WHERE user_id IS NULL;

ALTER TABLE verebona_conversations ALTER COLUMN user_id SET NOT NULL;

-- 4. Unicité : une conversation active par utilisateur DANS un compte.
CREATE UNIQUE INDEX IF NOT EXISTS verebona_conversations_active_user_uidx
  ON verebona_conversations (account_id, user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS verebona_conversations_owner_idx
  ON verebona_conversations (account_id, user_id, updated_at DESC);

-- 5. Idempotence propre à l'auteur : un clientRequestId rejoué par B ne
--    retrouve jamais la demande de A.
DROP INDEX IF EXISTS verebona_messages_idempotency_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS verebona_messages_user_idempotency_uidx
  ON verebona_messages (account_id, author_user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
