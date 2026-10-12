-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0335 : diagnostic des sondes de modèles et confirmation avant
-- dégradation — lot 49 (49E), ticket 11 « BO IA — Fiabiliser la détection
-- “modèle actif indisponible” et les sondes Gemini ».
--
-- `ai_model_operational_status` (0273) ne retenait qu'un booléen : un échec
-- de sonde, même non concluant (réponse vide, quota, clé), passait le modèle
-- à `ok = false`. Désormais :
--   · `ok` devient NULLABLE : NULL = état inconnu avec la clé active (un
--     contrôle non concluant ne crée jamais un `false`) ;
--   · `check_status` : issue du DERNIER contrôle — ok | inconclusive |
--     suspect | failed_confirmed (NULL : ligne antérieure au lot 49, relue
--     avec la classification du code) ;
--   · `error_kind` : catégorie de l'erreur fournisseur (quota, clé, modèle
--     retiré…) ; `error` reste le message NETTOYÉ (jamais de secret) ;
--   · `suspect_since` : premier échec présumé définitif, en attente de
--     confirmation par un second contrôle ;
--   · `last_ok_at` : dernière réponse saine.
--
-- Idempotente (ADD COLUMN IF NOT EXISTS ; DROP NOT NULL sans effet si déjà
-- fait). Aucune donnée existante modifiée.
-- ──────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('ai_model_operational_status') IS NULL THEN
    RETURN;
  END IF;
  ALTER TABLE ai_model_operational_status ALTER COLUMN ok DROP NOT NULL;
  ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS check_status TEXT;
  ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS error_kind TEXT;
  ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS suspect_since TIMESTAMPTZ;
  ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS last_ok_at TIMESTAMPTZ;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_model_operational_status_check_status_ck') THEN
    ALTER TABLE ai_model_operational_status ADD CONSTRAINT ai_model_operational_status_check_status_ck
      CHECK (check_status IS NULL OR check_status IN ('ok', 'inconclusive', 'suspect', 'failed_confirmed'));
  END IF;
END $$;

COMMENT ON TABLE ai_model_operational_status IS
  'Dernier contrôle de génération minimale par modèle (sonde, qualification, test de clé), avec l''empreinte de la clé testée '
  '— lot 32B ; lot 49 : ok NULL = inconnu, check_status ok|inconclusive|suspect|failed_confirmed, confirmation avant dégradation.';
