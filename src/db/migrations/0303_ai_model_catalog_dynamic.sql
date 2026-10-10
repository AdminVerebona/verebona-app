-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0303 : catalogue IA dynamique — modèles, qualification, bandeau BO
-- Lot 35B, ticket « Catalogue IA dynamique Google : modèles, tarifs, Preview et
-- alertes BO ».
--
-- 1. `ai_model_catalog` (0177) devient le catalogue DÉCOUVERT : tout modèle
--    Gemini listé par `GET /v1beta/models` avec la clé active y est enregistré,
--    sans modification du code. Colonnes ajoutées : statut fournisseur
--    (stable / preview / experimental / deprecated) et sa base (champ structuré
--    ou règle isolée), version, description, méthodes et détails rendus par
--    Google, dernier contrôle, date de disparition, acquittement du bandeau
--    « Nouveau modèle Gemini disponible ».
--
-- 2. BASELINE : les modèles DÉJÀ connus à la mise en service ne déclenchent
--    aucun bandeau. Ceux présents en base sont acquittés ici ; la première
--    synchronisation réussie après déploiement acquitte aussi ceux qu'elle
--    découvre (`baseline_done_at`), puis seuls les modèles réellement apparus
--    ensuite sont signalés. Le bloc ne s'applique que tant que cette baseline
--    n'a pas eu lieu : rejouer la migration n'acquitte jamais un modèle
--    découvert après la mise en service.
--
-- 3. `ai_model_qualification` : résultat de la qualification technique
--    automatique (génération réelle, sortie structurée conforme à un schéma
--    JSON, multimodal, raisonnement) par modèle, avec l'empreinte de la clé
--    testée — jamais la clé. Remplace la compatibilité T1–T6 déclarée à la
--    main modèle par modèle.
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE ai_model_catalog ADD COLUMN IF NOT EXISTS lifecycle         TEXT;
ALTER TABLE ai_model_catalog ADD COLUMN IF NOT EXISTS lifecycle_basis   TEXT;
ALTER TABLE ai_model_catalog ADD COLUMN IF NOT EXISTS version           TEXT;
ALTER TABLE ai_model_catalog ADD COLUMN IF NOT EXISTS description       TEXT;
ALTER TABLE ai_model_catalog ADD COLUMN IF NOT EXISTS supported_methods JSONB;
ALTER TABLE ai_model_catalog ADD COLUMN IF NOT EXISTS provider_details  JSONB;
ALTER TABLE ai_model_catalog ADD COLUMN IF NOT EXISTS last_checked_at   TIMESTAMPTZ;
ALTER TABLE ai_model_catalog ADD COLUMN IF NOT EXISTS disappeared_at    TIMESTAMPTZ;
ALTER TABLE ai_model_catalog ADD COLUMN IF NOT EXISTS acknowledged_at   TIMESTAMPTZ;
ALTER TABLE ai_model_catalog ADD COLUMN IF NOT EXISTS acknowledged_by   INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ai_model_catalog ADD COLUMN IF NOT EXISTS baseline          BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE ai_model_catalog_refresh ADD COLUMN IF NOT EXISTS baseline_done_at  TIMESTAMPTZ;
ALTER TABLE ai_model_catalog_refresh ADD COLUMN IF NOT EXISTS last_sync_at      TIMESTAMPTZ;
ALTER TABLE ai_model_catalog_refresh ADD COLUMN IF NOT EXISTS last_sync_trigger TEXT;
ALTER TABLE ai_model_catalog_refresh ADD COLUMN IF NOT EXISTS last_sync_summary JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ai_model_catalog_refresh WHERE baseline_done_at IS NOT NULL) THEN
    UPDATE ai_model_catalog
       SET acknowledged_at = NOW(), baseline = TRUE
     WHERE acknowledged_at IS NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_model_qualification (
  provider              TEXT        NOT NULL,
  model                 TEXT        NOT NULL,
  key_fingerprint       TEXT        NOT NULL,
  qualification_version TEXT        NOT NULL,
  generate_ok           BOOLEAN     NOT NULL,
  structured_ok         BOOLEAN,
  multimodal_ok         BOOLEAN,
  thinking_ok           BOOLEAN,
  errors                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  qualified_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, model)
);

COMMENT ON TABLE ai_model_qualification IS
  'Qualification technique automatique par modèle (génération, sortie structurée/schéma JSON, multimodal, raisonnement), '
  'avec l''empreinte de la clé testée — lot 35B. L''éligibilité T1–T6 en est déduite selon les capacités requises.';
COMMENT ON COLUMN ai_model_catalog.acknowledged_at IS
  'Acquittement du bandeau « Nouveau modèle Gemini disponible » (persistant, par modèle). Baseline à la mise en service.';
