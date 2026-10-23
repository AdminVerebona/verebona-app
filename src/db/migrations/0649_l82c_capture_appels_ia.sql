-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0649 : capture complète à la source des appels IA — lot 82C
-- (CDC Pilotage IA V2, phase P1 : LOG-01, LOG-02, LOG-04, LOG-05, LOG-07 à
-- LOG-10 ; décisions PO du 22/10 n° 01, 10, 11 et 15).
--
--   ai_call_captures — UNE ligne par tentative réelle d'appel à un modèle
--   (analyse, réparation ciblée, refus avant appel, sonde, qualification,
--   test du fournisseur), réussie ou non, pour TOUS les traitements (T1 à T6,
--   T2 compris) et l'usage technique AI_GOVERNANCE :
--     · prompt effectif final (texte réellement transmis), variables résolues
--       (une valeur longue déjà présente telle quelle dans le prompt est
--       remplacée par une référence { position, longueur, empreinte } : aucun
--       doublon), ordre des messages, pièces jointes par RÉFÉRENCE (type,
--       transport, chemin de stockage sans paramètre signé, empreinte des
--       données en ligne) — jamais le fichier lui-même ;
--     · paramètres effectivement envoyés (generationConfig construit,
--       raisonnement, plafond de sortie demandé / hérité / adapté / envoyé,
--       délai, structured output) et essais internes du même modèle ;
--     · réponse brute reçue, sortie après parsing, diagnostic ;
--     · statut de chaque contenu : CAPTURED, MASKED (masquage existant
--       appliqué : IBAN, cartes, clés, NIR), NOT_SENT / NO_RESPONSE,
--       NOT_CAPTURED (capture en échec ou désactivée, avec motif) ;
--     · durée PROPRE de la tentative et durée murale écoulée de l'exécution.
--   Rattachée à `ai_usage_event` par `usage_event_id` (pas de clé étrangère :
--   la capture ne doit jamais faire échouer la trace, ni l'inverse).
--
--   ai_call_capture_state — instant de mise en service de la capture : tout
--   appel antérieur est présenté « non conservé historiquement » (LOG-08),
--   jamais reconstitué.
--
-- Données issues des documents et conversations des utilisateurs : lues
-- UNIQUEMENT par les routes BO réservées (`AI_MODEL_OUTPUT_ADMIN_IDS`,
-- consultation journalisée). Aucune purge par ancienneté (décisions PO 01 et
-- 10). Suppression : suppression de compte / d'utilisateur (colonnes
-- `account_id` / `user_id`, sans clé étrangère : purge par le contrôle des
-- orphelins de `executeScheduledDeletion`), effacement manuel de l'historique
-- de l'assistant (`subject_ref`). Stockage TOAST (compression sans perte).
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_call_captures (
  id                   BIGSERIAL    PRIMARY KEY,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  captured_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  trace_id             TEXT         NOT NULL,
  usage_event_id       BIGINT,
  call_index           SMALLINT,
  call_kind            TEXT         NOT NULL,
  origin               TEXT         NOT NULL,
  account_id           INTEGER,
  user_id              INTEGER,
  job_id               BIGINT,
  use_case_code        TEXT,
  operation_code       TEXT         NOT NULL,
  task                 TEXT,
  model                TEXT,
  model_rank           TEXT,
  subject_ref          TEXT,
  source_ids           INTEGER[]    NOT NULL DEFAULT '{}',
  capture_status       TEXT         NOT NULL,
  capture_reason       TEXT,
  capture_attempts     SMALLINT     NOT NULL DEFAULT 1,
  prompt_status        TEXT         NOT NULL,
  prompt_text          TEXT,
  prompt_chars         INTEGER,
  prompt_sha256        TEXT,
  variables            JSONB,
  messages             JSONB,
  attachments          JSONB,
  request_params       JSONB,
  provider_steps       JSONB,
  response_status      TEXT         NOT NULL,
  response_raw         TEXT,
  response_chars       INTEGER,
  response_sha256      TEXT,
  parsed_output        JSONB,
  diagnostic           JSONB,
  masking              JSONB,
  attempt_duration_ms  INTEGER,
  execution_elapsed_ms INTEGER,
  capture_version      SMALLINT     NOT NULL DEFAULT 1,
  CONSTRAINT ai_call_captures_status_chk CHECK (capture_status IN ('CAPTURED', 'PARTIAL', 'NOT_CAPTURED')),
  CONSTRAINT ai_call_captures_prompt_status_chk CHECK (prompt_status IN ('CAPTURED', 'MASKED', 'NOT_SENT', 'NOT_CAPTURED')),
  CONSTRAINT ai_call_captures_response_status_chk CHECK (response_status IN ('CAPTURED', 'MASKED', 'NO_RESPONSE', 'NOT_CAPTURED'))
);

COMMENT ON TABLE ai_call_captures IS
  'Lot 82C (Pilotage IA V2 P1) : capture complète à la source de chaque tentative d''appel modèle (prompt final, contexte, paramètres envoyés, réponse brute, sortie parsée, diagnostic). Accès BO réservé (AI_MODEL_OUTPUT_ADMIN_IDS), journalisé. Aucune purge par ancienneté (décisions PO 01/10) ; purge à la suppression de compte / utilisateur et à l''effacement de l''historique de l''assistant.';
COMMENT ON COLUMN ai_call_captures.attempt_duration_ms IS
  'Durée PROPRE de la tentative (envoi → réponse ou erreur, essais internes du même modèle compris) ; jamais cumulée avec les tentatives précédentes.';
COMMENT ON COLUMN ai_call_captures.execution_elapsed_ms IS
  'Durée murale écoulée depuis le début de l''exécution de la passerelle à la fin de cette tentative (temps total, ne pas sommer).';
COMMENT ON COLUMN ai_call_captures.subject_ref IS
  'Objet de rattachement pour une suppression ciblée (ex. t2-conversation:<id>) ; NULL si sans objet.';

CREATE TABLE IF NOT EXISTS ai_call_capture_state (
  id          SMALLINT     PRIMARY KEY DEFAULT 1,
  started_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_call_capture_state_singleton CHECK (id = 1)
);
INSERT INTO ai_call_capture_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
