-- ─────────────────────────────────────────────────────────────────────────
-- Migration 1692 : IA — état opérationnel des modèles PAR ACCÈS, diagnostic
-- complet du dernier contrôle, prochaine sonde et historique des verdicts
-- (lot 114, carte Trello #771 « Fiabiliser les sondes de modèles et propager
-- les indisponibilités jusqu'au routage et aux promotions »).
--
-- `ai_model_operational_status` (0273, 0335) gardait UNE ligne par modèle :
-- le contrôle d'une autre clé (« Tester la clé » avant une rotation) écrasait
-- le verdict obtenu avec la clé active, et rien ne disait quand le contrôle
-- avait été ENVOYÉ (une réponse lente pouvait effacer un refus plus récent).
--
--   · clé primaire étendue à l'ACCÈS : (provider, model, key_fingerprint) —
--     l'empreinte non réversible de la clé, jamais la clé. Un verdict ne vaut
--     que pour l'accès qui l'a obtenu ;
--   · colonnes nouvelles (toutes facultatives ou avec défaut) :
--       http_status, provider_code   code HTTP et code fournisseur du refus ;
--       capability, endpoint         ce qui a été testé (génération de texte,
--                                    generateContent) ;
--       probe_call_id                appel technique tracé qui fonde le verdict ;
--       observed_at                  instant d'ENVOI du contrôle retenu (un
--                                    résultat observé avant lui est écarté) ;
--       confirmed_at                 date de l'indisponibilité confirmée ;
--       failure_count, next_probe_at recontrôle borné d'un modèle refusé ;
--       state_version                numéro d'ordre du verdict ;
--   · `ai_model_operational_history` (nouvelle) : chaque contrôle reçu, retenu
--     ou écarté (hors ordre), avec son diagnostic nettoyé. Aucun secret.
--
-- IDEMPOTENTE et NON DESTRUCTIVE : ADD COLUMN IF NOT EXISTS, CREATE TABLE IF
-- NOT EXISTS ; la clé primaire n'est remplacée que si elle porte encore deux
-- colonnes. Aucune ligne modifiée ni supprimée.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('ai_model_operational_status') IS NULL THEN
    RETURN;
  END IF;
  ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS http_status INTEGER;
  ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS provider_code TEXT;
  ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS capability TEXT NOT NULL DEFAULT 'text_generation';
  ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS endpoint TEXT;
  ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS probe_call_id BIGINT;
  ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ;
  ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
  ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS next_probe_at TIMESTAMPTZ;
  ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS state_version BIGINT NOT NULL DEFAULT 0;

  -- Clé primaire par accès (remplacée une seule fois).
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'ai_model_operational_status'::regclass AND contype = 'p' AND array_length(conkey, 1) = 2
  ) THEN
    EXECUTE (
      SELECT format('ALTER TABLE ai_model_operational_status DROP CONSTRAINT %I', conname)
        FROM pg_constraint
       WHERE conrelid = 'ai_model_operational_status'::regclass AND contype = 'p'
    );
    ALTER TABLE ai_model_operational_status
      ADD CONSTRAINT ai_model_operational_status_pkey PRIMARY KEY (provider, model, key_fingerprint);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_model_operational_history (
  id               BIGSERIAL PRIMARY KEY,
  provider         TEXT        NOT NULL,
  model            TEXT        NOT NULL,
  -- Empreinte non réversible de la clé (jamais la clé).
  key_fingerprint  TEXT        NOT NULL,
  capability       TEXT        NOT NULL DEFAULT 'text_generation',
  endpoint         TEXT,
  source           TEXT        NOT NULL,
  -- Issue du contrôle : ok | inconclusive | failed.
  outcome          TEXT        NOT NULL,
  definitive       BOOLEAN,
  error_kind       TEXT,
  http_status      INTEGER,
  provider_code    TEXT,
  -- Message fournisseur NETTOYÉ.
  error            TEXT,
  -- État après ce contrôle : ok | inconclusive | suspect | failed_confirmed ; état retenu.
  check_status     TEXT,
  ok_after         BOOLEAN,
  -- FALSE : contrôle écarté (observé avant le verdict en vigueur), état inchangé.
  applied          BOOLEAN     NOT NULL DEFAULT TRUE,
  state_version    BIGINT,
  probe_call_id    BIGINT,
  observed_at      TIMESTAMPTZ NOT NULL,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_model_operational_history_model_idx
  ON ai_model_operational_history (provider, model, key_fingerprint, recorded_at DESC);

COMMENT ON TABLE ai_model_operational_history IS
  'Historique des contrôles de disponibilité des modèles (sonde, qualification, test de clé, refus d''un appel réel), par accès '
  '(empreinte de clé), retenus ou écartés — lot 114, carte #771. Aucun secret, aucune donnée de compte.';
