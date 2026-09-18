-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0133 : traçabilité version et commit — CDC BO IA §9.1, GEN-008,
-- NFR-004, SCR-07.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- « UN ADMINISTRATEUR PEUT EXPLIQUER QUELLE VERSION/CONFIG/CODE A PRODUIT UN
-- RÉSULTAT »
--
-- C'est le premier critère d'acceptation du SCR-07, et `ai_usage_event` ne
-- permet pas d'y répondre : la trace dit quel modèle a été appelé et combien il
-- a coûté, jamais sous quelle configuration ni depuis quel code.
--
-- Or le GEN-008 rappelle pourquoi les deux comptent : « une partie du
-- comportement reste définie dans le code ». Deux exécutions sous la même
-- version IA peuvent différer si un déploiement les sépare — et sans le commit,
-- l'écart est inexplicable.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- LE RANG DU MODÈLE, PAS SEULEMENT « FALLBACK OUI OU NON »
--
-- Le §9.1 exige le « rang principal/fallback 1/fallback 2 ». `is_fallback` ne
-- distingue pas les deux replis : un traitement qui bascule systématiquement
-- sur le second, parce que le premier est lui aussi en panne, ressemble à un
-- traitement qui replie normalement. C'est pourtant un incident bien plus
-- sérieux, et le SCR-07 veut que « le fallback réellement utilisé soit visible ».
--
-- `is_fallback` est conservé : d'autres écrans le lisent, et le supprimer
-- demanderait de les reprendre dans le même mouvement.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- TOUTES LES COLONNES SONT NULLABLES
--
-- Les traces déjà écrites n'ont ni version ni commit, et il n'existe aucun
-- moyen honnête de les reconstituer. Une valeur par défaut leur attribuerait
-- une configuration qu'elles n'ont pas utilisée — pire qu'une absence, parce
-- qu'elle serait crue.
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE ai_usage_event
  ADD COLUMN IF NOT EXISTS config_version_id INTEGER
    REFERENCES ai_config_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS app_version TEXT,
  ADD COLUMN IF NOT EXISTS model_rank TEXT,
  ADD COLUMN IF NOT EXISTS job_id INTEGER
    REFERENCES ai_job_queue(id) ON DELETE SET NULL;

-- `primary` | `fallback_1` | `fallback_2`. Contrôle ajouté séparément pour
-- rester idempotent : `ADD CONSTRAINT IF NOT EXISTS` n'existe pas en Postgres.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_event_model_rank_check'
  ) THEN
    ALTER TABLE ai_usage_event
      ADD CONSTRAINT ai_usage_event_model_rank_check
      CHECK (model_rank IS NULL OR model_rank IN ('primary', 'fallback_1', 'fallback_2'));
  END IF;
END $$;

-- Le SCR-07 filtre par version et le §24 demande « quel modèle et quel fallback
-- ont réellement été utilisés » : deux index, deux questions posées souvent.
CREATE INDEX IF NOT EXISTS ai_usage_event_config_version_idx
  ON ai_usage_event(config_version_id) WHERE config_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_usage_event_job_idx
  ON ai_usage_event(job_id) WHERE job_id IS NOT NULL;

COMMENT ON COLUMN ai_usage_event.config_version_id IS
  'Version IA effective au moment de l''appel (CDC BO IA §9.1).';
COMMENT ON COLUMN ai_usage_event.app_version IS
  'Commit applicatif déployé (GEN-008) : une partie du comportement vit dans le code.';
COMMENT ON COLUMN ai_usage_event.model_rank IS
  'Rang du modèle réellement utilisé : primary, fallback_1 ou fallback_2 (§9.1).';
