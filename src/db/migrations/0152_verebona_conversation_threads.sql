-- =============================================================================
-- 0152 — Plusieurs fils de conversation par utilisateur.
--
-- La 0151 a rendu les conversations privées (compte + utilisateur), mais
-- conservait « une conversation active par utilisateur ». Un utilisateur peut
-- désormais tenir plusieurs fils indépendants et reprendre explicitement l'un
-- d'eux : la clé fonctionnelle devient compte + utilisateur + conversation.
--
--   · suppression de l'unicité active par (compte, utilisateur) ;
--   · title : libellé du fil (début de la première question) ;
--   · last_message_at : tri « fil le plus récent ».
-- =============================================================================

DROP INDEX IF EXISTS verebona_conversations_active_user_uidx;

ALTER TABLE verebona_conversations ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE verebona_conversations ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;

UPDATE verebona_conversations c
   SET title = COALESCE(c.title, (
         SELECT left(m.content, 80) FROM verebona_messages m
          WHERE m.conversation_id = c.id AND m.role = 'user'
          ORDER BY m.created_at, m.id LIMIT 1)),
       last_message_at = COALESCE(c.last_message_at, (
         SELECT max(m.created_at) FROM verebona_messages m WHERE m.conversation_id = c.id), c.updated_at);

CREATE INDEX IF NOT EXISTS verebona_conversations_threads_idx
  ON verebona_conversations (account_id, user_id, status, last_message_at DESC);
