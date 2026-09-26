-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0177 : catalogue des modèles du fournisseur
-- CDC BO IA E-04, PROV-UI-06, PROV-UI-07, PROV-UI-08, WF-29, WF-40, SCR-10.
--
-- Le catalogue était un fichier du code (`gemini-public-catalog.ts`) : un
-- modèle nouvellement servi n'était pas sélectionnable sans mise en
-- production, et un modèle retiré restait proposé (`available: true` pour
-- tous). Cette table reflète ce que le fournisseur liste réellement, au
-- dernier rafraîchissement manuel (bouton « Actualiser le catalogue »).
--
-- Un modèle disparu n'est pas supprimé : il est marqué indisponible, pour que
-- l'historique (versions, traces) continue de le nommer, et que la validation
-- d'une version qui l'emploie le refuse explicitement.
--
-- ai_model_catalog_refresh : dernier rafraîchissement (ligne unique). En cas
-- d'échec, le catalogue précédent est CONSERVÉ et signalé obsolète (WF-40).
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_model_catalog (
  provider           TEXT        NOT NULL,
  model              TEXT        NOT NULL,
  display_name       TEXT,
  available          BOOLEAN     NOT NULL DEFAULT TRUE,
  supports_generation BOOLEAN    NOT NULL DEFAULT TRUE,
  supports_thinking  BOOLEAN,
  input_token_limit  INTEGER,
  output_token_limit INTEGER,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, model)
);

CREATE TABLE IF NOT EXISTS ai_model_catalog_refresh (
  provider      TEXT        PRIMARY KEY,
  refreshed_at  TIMESTAMPTZ,
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ok            BOOLEAN     NOT NULL DEFAULT FALSE,
  error         TEXT,
  models_seen   INTEGER,
  refreshed_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL
);

COMMENT ON TABLE ai_model_catalog IS
  'Modèles listés par le fournisseur au dernier rafraîchissement (CDC BO IA E-04, WF-40). '
  'Un modèle disparu est marqué indisponible, jamais supprimé.';
