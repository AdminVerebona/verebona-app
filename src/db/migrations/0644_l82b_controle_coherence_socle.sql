-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0644 : socle du contrôle de cohérence global (lot 82B — arbitrages
-- PO du 23/10/2026 C-Q1, C-Q2, C-Q3, C-Q4, C-Q5, C-Q9, C-Q11, §3.1, §3.2).
--
-- UNE seule chaîne : le registre déclaratif des contrôles (code,
-- `src/services/coherence/registry`) et un orchestrateur unique qui
-- généralise le moteur de campagne « À traiter » (curseur en base, reprise,
-- bilan recalculé depuis les éléments consignés). Les réparations passent
-- par les services métier existants ; ces tables ne portent que la PREUVE de
-- contrôle et le journal des tentatives de réparation — jamais une donnée
-- métier.
--
--   coherence_campaigns       une campagne (quotidienne exhaustive, de
--                             rattrapage à la réactivation d'un compte,
--                             manuelle depuis le BO) : mode (à blanc /
--                             correctif), version du registre, statut
--                             technique (RUNNING / COMPLETE / PARTIAL /
--                             FAILED, indépendant du résultat métier),
--                             curseur persistant, compteurs, couverture
--                             vérifiée, mesures (durée, CPU, mémoire, appels
--                             IA). Une campagne partielle ou échouée n'est
--                             jamais déclarée exhaustive (C-Q4).
--   coherence_object_proofs   PREUVE TECHNIQUE par objet éligible et par
--                             contrôle (C-Q4) : contrôle lancé, achevé,
--                             réussi (dates distinctes), résultat, version
--                             des règles ; constat courant (sans doublon :
--                             une ligne par objet × contrôle), série de
--                             constats, empreinte anti-boucle, demande de
--                             contrôle ciblé (changement d'une dépendance).
--                             Aucune ligne par exécution réussie : la preuve
--                             est synthétique.
--   coherence_repairs         tentatives de réparation (origine, service
--                             métier appelé, état avant / résultat,
--                             recontrôle, erreur, référence de retour arrière
--                             vers le journal du domaine) — C-Q2.
--
-- Aucun onglet BO (C-Q3) : échecs, constats persistants et répétitions sont
-- signalés dans la Supervision existante (`admin_anomalies`).
--
-- Tables créées par SQL brut (lecture / écriture `pgClient`, comme les
-- campagnes « À traiter » 0445) : aucune déclaration Drizzle.
-- Idempotente, rejouable. Retour arrière : tables ignorées par l'ancien code
-- (DROP TABLE possible, aucune donnée métier).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS coherence_campaigns (
  id                  BIGSERIAL   PRIMARY KEY,
  kind                TEXT        NOT NULL,
  mode                TEXT        NOT NULL,
  campaign_date       DATE,
  scope_account_ids   INTEGER[],
  trigger_code        TEXT        NOT NULL,
  registry_version    TEXT        NOT NULL,
  checks              JSONB       NOT NULL DEFAULT '[]'::jsonb,
  status              TEXT        NOT NULL DEFAULT 'RUNNING',
  phase               TEXT        NOT NULL DEFAULT 'TRAVERSE',
  cursor_account_id   INTEGER     NOT NULL DEFAULT 0,
  cursor_check_index  INTEGER     NOT NULL DEFAULT 0,
  cursor_object_id    BIGINT      NOT NULL DEFAULT 0,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline_at         TIMESTAMPTZ,
  last_run_at         TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  runs                INTEGER     NOT NULL DEFAULT 0,
  accounts            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  counters            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  metrics             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  coverage            JSONB,
  remaining           JSONB,
  error_sample        TEXT,
  CONSTRAINT coherence_campaigns_kind_check CHECK (kind IN ('DAILY', 'CATCHUP', 'MANUAL')),
  CONSTRAINT coherence_campaigns_mode_check CHECK (mode IN ('DRY_RUN', 'CORRECTIVE')),
  CONSTRAINT coherence_campaigns_status_check CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETE', 'PARTIAL', 'FAILED')),
  CONSTRAINT coherence_campaigns_phase_check CHECK (phase IN ('TRAVERSE', 'VERIFY', 'DONE'))
);

COMMENT ON TABLE coherence_campaigns IS
  'Lot 82B : campagnes du contrôle de cohérence global (quotidienne exhaustive, rattrapage à la réactivation, manuelle). Statut technique indépendant du résultat métier ; PARTIAL / FAILED jamais exhaustive.';

-- Une seule campagne quotidienne par jour (Paris).
CREATE UNIQUE INDEX IF NOT EXISTS coherence_campaigns_daily_uniq
  ON coherence_campaigns (campaign_date) WHERE kind = 'DAILY';
CREATE INDEX IF NOT EXISTS coherence_campaigns_running_idx
  ON coherence_campaigns (kind, id) WHERE status = 'RUNNING';

CREATE TABLE IF NOT EXISTS coherence_object_proofs (
  account_id          INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  check_id            TEXT        NOT NULL,
  object_id           BIGINT      NOT NULL,
  object_type         TEXT        NOT NULL,
  rules_version       INTEGER     NOT NULL,
  registry_version    TEXT        NOT NULL,
  last_campaign_id    BIGINT,
  last_trigger        TEXT,
  last_mode           TEXT,
  last_started_at     TIMESTAMPTZ,
  last_completed_at   TIMESTAMPTZ,
  last_success_at     TIMESTAMPTZ,
  last_result         TEXT,
  finding             JSONB,
  finding_hash        TEXT,
  first_detected_at   TIMESTAMPTZ,
  finding_streak      INTEGER     NOT NULL DEFAULT 0,
  consecutive_errors  INTEGER     NOT NULL DEFAULT 0,
  last_error          TEXT,
  last_repair_hash    TEXT,
  last_repair_at      TIMESTAMPTZ,
  repair_attempts     INTEGER     NOT NULL DEFAULT 0,
  requested_at        TIMESTAMPTZ,
  request_reason      TEXT,
  next_retry_at       TIMESTAMPTZ,
  PRIMARY KEY (account_id, check_id, object_id)
);

COMMENT ON TABLE coherence_object_proofs IS
  'Lot 82B (C-Q4) : preuve technique de contrôle par objet éligible et par contrôle (lancé / achevé / réussi, résultat, version des règles), constat courant sans doublon, demande de contrôle ciblé. Jamais affichée à l''utilisateur.';

CREATE INDEX IF NOT EXISTS coherence_object_proofs_requested_idx
  ON coherence_object_proofs (requested_at) WHERE requested_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS coherence_object_proofs_retry_idx
  ON coherence_object_proofs (next_retry_at) WHERE next_retry_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS coherence_object_proofs_result_idx
  ON coherence_object_proofs (check_id, last_result) WHERE last_result IS NOT NULL AND last_result NOT IN ('CONSISTENT', 'GONE', 'REPAIRED');

CREATE TABLE IF NOT EXISTS coherence_repairs (
  id                  BIGSERIAL   PRIMARY KEY,
  campaign_id         BIGINT,
  account_id          INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  check_id            TEXT        NOT NULL,
  check_version       INTEGER     NOT NULL,
  object_type         TEXT        NOT NULL,
  object_id           BIGINT      NOT NULL,
  trigger_code        TEXT        NOT NULL,
  anomaly             TEXT        NOT NULL,
  faulty_link         TEXT,
  service             TEXT        NOT NULL,
  input_hash          TEXT,
  before_state        JSONB,
  result              JSONB,
  outcome             TEXT        NOT NULL,
  recheck_verdict     TEXT,
  rollback_ref        TEXT,
  error               TEXT,
  ai_calls            INTEGER     NOT NULL DEFAULT 0,
  duration_ms         INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT coherence_repairs_outcome_check CHECK (outcome IN ('REPAIRED', 'INEFFECTIVE', 'FAILED'))
);

COMMENT ON TABLE coherence_repairs IS
  'Lot 82B (C-Q2) : tentatives de réparation du contrôle de cohérence (service métier appelé, état avant, résultat, recontrôle, erreur, référence de retour arrière vers le journal du domaine).';

CREATE INDEX IF NOT EXISTS coherence_repairs_object_idx
  ON coherence_repairs (account_id, check_id, object_id, id);
CREATE INDEX IF NOT EXISTS coherence_repairs_created_idx
  ON coherence_repairs (created_at);
