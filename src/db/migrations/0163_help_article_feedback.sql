-- Retours « Cet article vous a-t-il aidé ? » — CDC Centre d'aide V1,
-- FEEDBACK-01 et FEEDBACK-02.
--
-- Enregistre l'ID d'article, le choix, la date et le commentaire facultatif.
-- Aucune donnée d'identification : ni compte, ni adresse IP (la limitation de
-- débit est tenue en mémoire). Le commentaire est un texte brut borné,
-- jamais rendu en HTML.
CREATE TABLE IF NOT EXISTS help_article_feedback (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id                TEXT        NOT NULL CHECK (article_id ~ '^AID-[A-Z]+-[0-9]{3}$'),
  helpful                   BOOLEAN     NOT NULL,
  comment                   TEXT        CHECK (comment IS NULL OR char_length(comment) <= 1000),
  content_version           TEXT        CHECK (content_version IS NULL OR char_length(content_version) <= 64),
  -- Jeton à usage unique permettant d'ajouter UN commentaire au vote « Non »
  -- qu'on vient d'émettre ; seul son condensat est conservé.
  comment_token_hash        TEXT,
  comment_token_expires_at  TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  commented_at              TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS help_article_feedback_article_idx ON help_article_feedback (article_id, created_at DESC);
