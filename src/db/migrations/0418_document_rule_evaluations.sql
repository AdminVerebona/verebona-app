-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0418 : diagnostic par règle documentaire « À traiter » (lot 58B —
-- ticket P1 « À traiter : questions inutiles sur des échéances passées et
-- données déjà connues », §3.D).
--
--   document_rule_evaluations — une ligne par ÉVALUATION SIGNIFICATIVE d'une
--   règle du pont documentaire (DATA-CONTRACT-END, DATA-WARRANTY-END,
--   DATA-SUPPLIER…) sur un document : déclencheur (analyse T1, balayage,
--   passage T3, correction utilisateur), référence d'exécution, version du
--   traitement, faits et sources consultés, résultats de normalisation et
--   rejets, présence du champ cible, évaluation de la pertinence métier
--   (échéance passée : décision T4 CLASSIFY_EVENT, trace IA), décision
--   (écriture, création, maintien, fermeture, aucune action), justification,
--   erreur éventuelle et étape en échec.
--
--   Une réévaluation IDENTIQUE (même signature) ne crée pas de ligne : elle
--   met à jour `last_seen_at` et `seen_count` de la dernière — le balayage
--   horaire n'inflige pas une ligne par heure. La dernière évaluation
--   « sans intervention nécessaire » d'une échéance passée sert aussi de
--   mémoire : la carte n'est pas recréée et l'IA n'est pas rappelée tant que
--   les éléments (dates candidates, type du document) n'ont pas changé.
--
-- Identifiants, codes, dates et extraits courts (≤ 120 caractères) : aucune
-- pièce jointe, aucun texte intégral. Le code tolère l'absence de la table
-- (diagnostic seulement, la décision est la même). Idempotente. Retour
-- arrière : DROP TABLE IF EXISTS document_rule_evaluations (code tolérant).
-- Index dans 0418_..._idx_1 (CONCURRENTLY).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_rule_evaluations (
  id               BIGSERIAL   PRIMARY KEY,
  account_id       INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id          INTEGER     NOT NULL,
  rule_code        TEXT        NOT NULL,
  field_key        TEXT,
  -- ANALYSIS | SWEEP | T3 | USER
  trigger_code     TEXT        NOT NULL,
  -- Référence d'exécution (job de file, passage T3, exécution T1) si connue.
  run_ref          TEXT,
  engine_version   TEXT        NOT NULL,
  target_present   BOOLEAN,
  user_validated   BOOLEAN,
  -- Sources consultées (nombre d'éléments par source) et sources absentes.
  sources          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  missing_sources  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- Valeurs lues : [{source, key, raw, normalized, status}] (≤ 30).
  observations     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- Propositions retenues : [{value, confidence}] (≤ 10).
  proposals        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- Indice du titre / nom de fichier : {dates, confirmed}.
  title_hint       JSONB,
  -- NOT_EVALUATED | FUTURE_OR_UNDATED | ACTION_REQUIRED | NO_ACTION_NEEDED | UNDECIDED | CACHED_*
  pertinence       TEXT,
  pertinence_reason TEXT,
  ai_operation     TEXT,
  ai_trace_id      TEXT,
  ai_status        TEXT,
  -- WRITE | CREATE | UPDATE | KEEP | CLOSE | NONE | ERROR
  decision         TEXT        NOT NULL,
  reason_code      TEXT,
  action_id        INTEGER,
  write_verified   BOOLEAN,
  error            TEXT,
  failed_step      TEXT,
  signature        TEXT        NOT NULL,
  pertinence_signature TEXT,
  seen_count       INTEGER     NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE document_rule_evaluations IS
  'Lot 58B : diagnostic par règle documentaire « À traiter » (sources, normalisation, pertinence métier, décision, justification). Lecture BO › File d''attente IA › Diagnostic des « À traiter ».';
