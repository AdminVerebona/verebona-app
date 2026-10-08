-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0284 : rapport de diagnostic par appel modèle — lot 33D (tickets
-- « rapports d'échec IA diagnostiquables » et « réussite malgré les
-- désalignements »).
--
-- Une ligne par appel modèle de la cascade (principal, replis, passes de
-- réparation ciblée) pour lequel un diagnostic existe : appel en échec, ou
-- réussi APRÈS correction (normalisation, adaptateur, réparation). Un appel
-- réussi tel quel n'écrit rien (aucun coût de stockage en régime nominal).
--
--   · famille / sous-type / étape de l'échec (`failure_*`), signature stable
--     (comparaison de cascade, rejeu des documents en échec) ;
--   · `diagnostic` : chaîne de contrôles, erreurs par chemin (attendu, reçu,
--     valeur masquée), métadonnées fournisseur (finish_reason, jetons,
--     identifiant de réponse…), corrections appliquées, contrat de sortie ;
--   · `raw_output` / `extracted_output` / `parsed_output` : SORTIE DU MODÈLE,
--     masquée (`redact` : IBAN, cartes, clés, NIR) et bornée. Données issues
--     des documents des utilisateurs : lue UNIQUEMENT par la route BO
--     d'administration dédiée (accès journalisé), jamais archivée sur S3,
--     jamais écrite dans les journaux ni transmise à un outil de supervision
--     externe ; supprimée avec la ligne à l'horizon de rétention des traces IA
--     (AI_LOG_ARCHIVE_AFTER_DAYS, 88 jours par défaut — tâche planifiée
--     `ai-call-diagnostics-purge`). Jamais conservée pour l'assistant (T2,
--     CDC Assistant §29.6 : empreinte seulement).
--
-- Pas de clé étrangère vers `ai_usage_event` : l’archivage des traces supprime
-- les appels de plus de 88 jours, la purge de cette table suit le même horizon.
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_call_diagnostics (
  id                BIGSERIAL    PRIMARY KEY,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  trace_id          TEXT         NOT NULL,
  usage_event_id    BIGINT,
  call_index        SMALLINT     NOT NULL DEFAULT 0,
  call_kind         TEXT         NOT NULL DEFAULT 'analysis',
  account_id        INTEGER,
  use_case_code     TEXT,
  operation_code    TEXT         NOT NULL,
  task              TEXT,
  model             TEXT,
  model_rank        TEXT,
  outcome           TEXT         NOT NULL,
  failure_family    TEXT,
  failure_subtype   TEXT,
  failure_stage     TEXT,
  signature         TEXT,
  source_ids        INTEGER[]    NOT NULL DEFAULT '{}',
  schema_name       TEXT,
  schema_version    TEXT,
  schema_hash       TEXT,
  diagnostic        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  raw_output        TEXT,
  extracted_output  TEXT,
  parsed_output     JSONB,
  output_chars      INTEGER,
  CONSTRAINT ai_call_diagnostics_outcome_chk CHECK (outcome IN ('SUCCEEDED', 'REPAIRED', 'FAILED')),
  CONSTRAINT ai_call_diagnostics_kind_chk CHECK (call_kind IN ('analysis', 'repair'))
);

COMMENT ON TABLE ai_call_diagnostics IS
  'Diagnostic par appel modèle (échec ou réussite après correction) — lot 33D. Sortie modèle masquée, accès BO admin journalisé, '
  'purgée à l''horizon des traces IA (AI_LOG_ARCHIVE_AFTER_DAYS), jamais archivée.';
COMMENT ON COLUMN ai_call_diagnostics.raw_output IS
  'Réponse brute du modèle, masquée (redact) et bornée — données utilisateur : BO admin uniquement, jamais journalisée ni archivée.';
