-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0132 : file durable et circuit breaker — CDC BO IA GEN-004,
-- NFR-003, SCR-08, §15.2, WF-09 à WF-11.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- « UN JOB NE PEUT PAS ÊTRE PERDU APRÈS UN REDÉMARRAGE APPLICATIF »
--
-- C'est le premier critère d'acceptation du SCR-08, et il condamne les
-- planificateurs en mémoire. Aujourd'hui, `analysis-recovery-scheduler` tient
-- son état dans un `setInterval` : un redéploiement — il y en a eu trois ce
-- matin — repart de zéro. `job_locks` (migration 0127) protège d'une exécution
-- concurrente, pas d'une perte : le bail survit, la file non.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- LA CLÉ DE DÉDUPLICATION N'INCLUT PAS LE DÉCLENCHEUR
--
-- Le WF-10 est explicite : « le déclencheur d'origine n'entre pas dans la clé ».
-- Autrement dit, un dépôt de document et une planification qui visent le même
-- objet sont la même exécution. L'y inclure produirait deux analyses du même
-- fichier parce qu'elles ont été demandées par deux chemins — précisément le
-- défaut n°1 du CDC de refonte, « un même document peut déclencher plusieurs
-- appels IA successifs ».
--
-- L'unicité ne porte donc que sur les états vivants. Un job terminé ne doit pas
-- empêcher une exécution ultérieure du même périmètre : c'est un index partiel,
-- pas une contrainte pleine.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- COALESCENCE PLUTÔT QUE DOUBLON
--
-- Le WF-10 : un événement pertinent pendant une exécution en cours ne crée pas
-- un second job, il demande « un seul passage supplémentaire consolidé ». D'où
-- `coalesce_requested` : un drapeau sur le job en cours, et non une seconde
-- ligne. Dix événements pendant une analyse produisent un passage, pas dix.
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_job_queue (
  id                SERIAL      PRIMARY KEY,

  -- T1, T3 ou T4 : seuls les traitements batch passent par la file (GEN-004).
  treatment         TEXT        NOT NULL,

  -- Périmètre de l'exécution. `account_id` nul = périmètre global.
  account_id        INTEGER     REFERENCES accounts(id) ON DELETE CASCADE,
  target_type       TEXT,
  target_id         TEXT,

  -- Clé de déduplication : traitement + périmètre, sans le déclencheur (WF-10).
  dedupe_key        TEXT        NOT NULL,

  status            TEXT        NOT NULL DEFAULT 'PENDING',

  -- WF-11 : une exécution manuelle est explicitement identifiable, et ne se
  -- confond jamais avec un passage automatique dans les journaux.
  origin            TEXT        NOT NULL DEFAULT 'automatic',
  trigger_code      TEXT,

  -- Version de configuration utilisée. Renseignée au démarrage, pas à la mise
  -- en file : le WF-05 veut que « les jobs déjà en file mais non démarrés »
  -- utilisent la nouvelle Active.
  config_version_id INTEGER     REFERENCES ai_config_versions(id) ON DELETE SET NULL,

  attempts          INTEGER     NOT NULL DEFAULT 0,
  last_error        TEXT,

  -- MOD-005 : retour en file avec backoff progressif. `available_at` porte la
  -- date de reprise, que le SCR-08 doit afficher.
  available_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- WF-10 : un seul passage supplémentaire consolidé, jamais un doublon.
  coalesce_requested BOOLEAN    NOT NULL DEFAULT FALSE,

  -- Remise en tête après interruption par désactivation, Emergency Stop ou
  -- rollback (SCR-08). FIFO par défaut, `head_priority` d'abord.
  head_priority     BOOLEAN     NOT NULL DEFAULT FALSE,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  cancelled_by      INTEGER     REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT ai_job_queue_treatment_check
    CHECK (treatment IN ('T1', 'T3', 'T4')),

  CONSTRAINT ai_job_queue_status_check
    CHECK (status IN ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED')),

  CONSTRAINT ai_job_queue_origin_check
    CHECK (origin IN ('automatic', 'manual'))
);

-- ⚠️ Déduplication : un seul job VIVANT par clé (WF-10). Partiel, parce qu'un
-- job terminé ne doit pas interdire une exécution ultérieure du même périmètre.
--
-- Les lancements manuels en sont exclus : le WF-11 demande explicitement de
-- « créer une nouvelle exécution même si un job automatique équivalent existe ».
CREATE UNIQUE INDEX IF NOT EXISTS ai_job_queue_dedupe_uidx
  ON ai_job_queue(dedupe_key)
  WHERE status IN ('PENDING', 'RUNNING') AND origin = 'automatic';

-- Ordre de service : tête de file d'abord, puis FIFO (SCR-08).
CREATE INDEX IF NOT EXISTS ai_job_queue_next_idx
  ON ai_job_queue(treatment, status, head_priority DESC, created_at)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS ai_job_queue_account_idx ON ai_job_queue(account_id);
CREATE INDEX IF NOT EXISTS ai_job_queue_status_idx  ON ai_job_queue(status);

COMMENT ON TABLE ai_job_queue IS
  'File durable des traitements batch T1/T3/T4 (CDC BO IA GEN-004, NFR-003). '
  'Survit aux redémarrages : aucun job ne se perd.';

-- ── État opérationnel et circuit breaker ────────────────────────────────────
--
-- GEN-001 : ceci est de l'état RUNTIME, pas de la configuration. Il ne figure
-- dans aucune version, n'entre dans aucun package (VER-011), et un rollback de
-- configuration ne doit jamais rallumer un traitement que quelqu'un a coupé.
CREATE TABLE IF NOT EXISTS ai_treatment_state (
  treatment          TEXT        PRIMARY KEY,

  -- §4.2 : activé, désactivé manuellement, suspendu automatiquement.
  state              TEXT        NOT NULL DEFAULT 'ENABLED',

  -- Cause et horodatage de la suspension, que le Dashboard doit afficher (WF-09).
  suspended_reason   TEXT,
  suspended_at       TIMESTAMPTZ,

  -- Prochaine probe. Le WF-09 demande un « planning progressif » et l'affichage
  -- de la prochaine tentative de recovery.
  next_probe_at      TIMESTAMPTZ,
  probe_attempts     INTEGER     NOT NULL DEFAULT 0,

  -- MOD-007 : un compteur d'échecs consécutifs PAR MODÈLE, pas par traitement.
  -- MOD-009 : un échec du principal compte même si un fallback réussit.
  model_failures     JSONB       NOT NULL DEFAULT '{}'::jsonb,

  updated_by         INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ai_treatment_state_check
    CHECK (state IN ('ENABLED', 'DISABLED', 'SUSPENDED')),

  CONSTRAINT ai_treatment_state_treatment_check
    CHECK (treatment IN ('T1', 'T2', 'T3', 'T4', 'T5'))
);

COMMENT ON TABLE ai_treatment_state IS
  'État opérationnel runtime des traitements (CDC BO IA §4.2, GEN-001). '
  'Hors configuration versionnée : jamais dans un package ni dans un rollback.';

-- ── Arrêt d'urgence global ──────────────────────────────────────────────────
--
-- §4.3 : distinct des états locaux. Il bloque les appels IA de tout
-- l'environnement SANS écraser les états préexistants des traitements — c'est
-- pourquoi c'est une ligne séparée, et non un passage de tous les traitements
-- à « suspendu » : au relâchement, chacun doit retrouver son état d'avant.
CREATE TABLE IF NOT EXISTS ai_emergency_stop (
  id            BOOLEAN     PRIMARY KEY DEFAULT TRUE,
  active        BOOLEAN     NOT NULL DEFAULT FALSE,
  reason        TEXT,
  engaged_by    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  engaged_at    TIMESTAMPTZ,
  released_by   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  released_at   TIMESTAMPTZ,

  CONSTRAINT ai_emergency_stop_singleton CHECK (id = TRUE)
);

INSERT INTO ai_emergency_stop (id, active) VALUES (TRUE, FALSE)
  ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE ai_emergency_stop IS
  'Arrêt d''urgence global (CDC BO IA §4.3). Ligne unique. '
  'N''écrase pas les états locaux : ils sont retrouvés au relâchement.';
