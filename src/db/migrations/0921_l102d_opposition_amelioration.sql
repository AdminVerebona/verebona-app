-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0921 : opposition à l'utilisation secondaire des données pour
-- l'amélioration (lot 102D ; décision PO du 30/10/2026 : usage interne pour
-- tests / qualité / optimisation des traitements automatisés selon la
-- politique, sans entraînement générique des modèles des prestataires, sans
-- accès humain général). Service : `src/services/privacy/improvement-opt-out.ts`.
--
--   · account_data_use_preferences : état courant, une ligne par compte.
--       improvement_opt_out  opposition active ;
--       excluded_before      les captures d'appels IA (`ai_call_captures`)
--                            antérieures à cet instant ne servent plus à
--                            l'amélioration. 'infinity' tant que l'opposition
--                            est active ; au retrait de l'opposition, figé à
--                            l'instant du retrait : ce qui a été capturé
--                            avant ou pendant l'opposition reste exclu pour
--                            toujours (choix par défaut, le plus protecteur).
--   · account_data_use_preference_events : journal de preuve (qui, quand,
--     canal, libellé exact affiché et son empreinte, navigateur abrégé).
--     Aucune adresse IP conservée.
--
-- Supprimées avec le compte (ON DELETE CASCADE). Additive et idempotente.
-- Tables neuves : clés primaires seules ici, l'index du journal est dans
-- 0921_..._idx_1 (CONCURRENTLY).
-- Retour arrière : DROP TABLE IF EXISTS account_data_use_preference_events,
-- account_data_use_preferences (les usages d'amélioration reprennent alors
-- tous les comptes : à éviter).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS account_data_use_preferences (
  account_id            INTEGER     PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  improvement_opt_out   BOOLEAN     NOT NULL DEFAULT false,
  opted_out_at          TIMESTAMPTZ,
  opted_out_by_user_id  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  withdrawn_at          TIMESTAMPTZ,
  excluded_before       TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_data_use_preference_events (
  id             BIGSERIAL   PRIMARY KEY,
  account_id     INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id        INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  action         TEXT        NOT NULL CHECK (action IN ('OPT_OUT', 'OPT_IN')),
  channel        TEXT        NOT NULL CHECK (channel IN ('web', 'mobile', 'admin')),
  label_shown    TEXT        NOT NULL,
  label_sha256   TEXT        NOT NULL,
  user_agent     TEXT,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
