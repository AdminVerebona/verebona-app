-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1522 : état du cache tarifaire PAR INSTANCE (lot 113O, carte #713,
-- critère 6 « cache et version tarifaire identiques entre instances »).
--
-- Chaque instance écrit, à chaque chargement de son cache de prix, sa version
-- partagée chargée, l'heure, le nombre de tarifs et l'état dégradé. Le rapport
-- de réconciliation (BO › Fournisseur IA › Tarifs) compare ces lignes à la clé
-- partagée `verebona_cache_versions` (périmètre `ai-pricing`). Aucune donnée
-- personnelle ni secret ; identifiant d'instance = conteneur (variable
-- CONTAINER) ou nom d'hôte, et numéro de processus.
-- Additive, idempotente, rejouable.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_pricing_cache_instances (
  instance_id   TEXT        PRIMARY KEY,
  version       BIGINT,
  loaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  prices        INTEGER     NOT NULL DEFAULT 0,
  degraded      BOOLEAN     NOT NULL DEFAULT FALSE,
  last_error    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
