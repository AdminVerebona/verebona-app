-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0273 : état opérationnel connu de chaque modèle, par clé
-- Lot 32B — ticket « BO IA : ne proposer que les modèles réellement
-- utilisables par traitement » (§1.H).
--
-- Être listé par `GET /v1beta/models` ne garantit pas qu'une génération
-- aboutisse (18/09/2026 : `gemini-2.5-flash-lite` listé, génération refusée).
-- Cette table conserve le résultat de la DERNIÈRE génération minimale connue
-- par modèle (test de la clé, actualisation du catalogue) avec l'empreinte de
-- la clé testée — jamais la clé. `usableModelsForTreatment` écarte un modèle
-- explicitement non opérationnel AVEC LA CLÉ ACTIVE ; un résultat obtenu avec
-- une autre clé est ignoré. Aucun appel fournisseur n'est fait pour afficher
-- le BO : la table est lue, jamais rafraîchie à l'affichage.
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_model_operational_status (
  provider         TEXT        NOT NULL,
  model            TEXT        NOT NULL,
  key_fingerprint  TEXT        NOT NULL,
  ok               BOOLEAN     NOT NULL,
  error            TEXT,
  source           TEXT        NOT NULL,
  checked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, model)
);

COMMENT ON TABLE ai_model_operational_status IS
  'Dernière génération minimale connue par modèle (test de clé, actualisation du catalogue), avec l''empreinte de la clé testée '
  '— lot 32B. Un modèle explicitement non opérationnel avec la clé active n''est plus proposé au BO.';
