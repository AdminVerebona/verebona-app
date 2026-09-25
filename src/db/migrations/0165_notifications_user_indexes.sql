-- Cloche des notifications : la liste (dernières d'un utilisateur) et le
-- compteur de non-lues ne disposaient que d'index à une colonne. Sur une table
-- qui grossit sans purge, Postgres lisait toutes les lignes de l'utilisateur
-- puis triait. Deux index composites servent exactement les deux requêtes.
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications (user_id)
  WHERE read_at IS NULL;
