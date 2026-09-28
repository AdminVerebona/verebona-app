-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0209 : assistant Verebona — versions d'invalidation du cache
-- CDC Assistant §31.4, §31.5, §31.7, CA-26.
--
-- Le cache de retrieval est propre à chaque processus : un événement métier
-- n'invalidait que l'instance qui l'avait reçu, les autres pouvaient resservir
-- une donnée modifiée jusqu'à 60 s.
--
-- Chaque événement d'invalidation incrémente ici la version du périmètre
-- concerné (`account:<id>` pour un compte, `global` pour un événement global
-- comme la publication d'un article d'aide). La version est lue avant chaque
-- lecture du cache et fait partie de la clé : une entrée calculée avant la
-- modification n'est plus jamais atteinte, quelle que soit l'instance.
--
-- Incrément hors de la transaction métier (après l'écriture), en une
-- instruction : verrou de ligne très bref, aucun risque d'interblocage.
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS verebona_cache_versions (
  scope       TEXT        PRIMARY KEY,
  version     BIGINT      NOT NULL DEFAULT 0,
  last_reason TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE verebona_cache_versions IS
  'Versions d''invalidation du cache de l''assistant (CDC §31.7, CA-26) : '
  'scope « account:<id> » ou « global », incrémentée à chaque événement métier.';

-- Purge des réponses modèle en cache d'un compte (événements de suppression,
-- `events/handlers.ts`) : filtre par préfixe constant `assistant:c…`. Sans
-- index `text_pattern_ops`, un LIKE par préfixe ne peut pas utiliser la clé
-- primaire (collation non C) et parcourt toute la table.
DO $$
BEGIN
  IF to_regclass('ai_operation_idempotency') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS ai_operation_idempotency_key_prefix_idx
      ON ai_operation_idempotency (key_hash text_pattern_ops);
  END IF;
END $$;
