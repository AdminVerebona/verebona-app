-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0857 : cache TEMPORAIRE des réponses modèle — renouvellement et
-- concurrence multi-instances (lot 99A, ticket P1 T3, point B).
--
-- `ai_operation_idempotency` gardait une entrée EXPIRÉE tant que la purge ne
-- l'avait pas supprimée, et `ON CONFLICT DO NOTHING` empêchait de la remplacer :
-- chaque appel suivant repartait au fournisseur. Désormais
-- (`idempotency.service.ts`) :
--   · `state` = READY (réponse servable) | PENDING (appel en cours, réservé par
--     `owner_token` jusqu'à `expires_at` = fin du bail) ;
--   · une entrée expirée ou un bail échu est REPRIS par insertion
--     conditionnelle (une seule instance gagne : un seul appel fournisseur) ;
--   · une entrée valide est conservée telle quelle ;
--   · `hit_count` / `last_hit_at` : réponses servies sans appel ;
--     `renewed_count` / `renewed_at` : entrées expirées renouvelées.
--
-- Additive, idempotente : colonnes à valeur par défaut constante (aucune
-- réécriture de table), lignes existantes READY. Clés réservées (corpus d'aide)
-- inchangées. Retour arrière : les colonnes peuvent rester (l'ancien code les
-- ignore).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_operation_idempotency ADD COLUMN IF NOT EXISTS state         TEXT        NOT NULL DEFAULT 'READY';
ALTER TABLE ai_operation_idempotency ADD COLUMN IF NOT EXISTS owner_token   TEXT;
ALTER TABLE ai_operation_idempotency ADD COLUMN IF NOT EXISTS hit_count     INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE ai_operation_idempotency ADD COLUMN IF NOT EXISTS last_hit_at   TIMESTAMPTZ;
ALTER TABLE ai_operation_idempotency ADD COLUMN IF NOT EXISTS renewed_count INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE ai_operation_idempotency ADD COLUMN IF NOT EXISTS renewed_at    TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_operation_idempotency'::regclass
                  AND conname = 'ai_operation_idempotency_state_chk') THEN
    ALTER TABLE ai_operation_idempotency ADD CONSTRAINT ai_operation_idempotency_state_chk
      CHECK (state IN ('READY', 'PENDING')) NOT VALID;
  END IF;
END $$;
