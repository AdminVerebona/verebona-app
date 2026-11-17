-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1805 : IDENTITÉ DES DEMANDES DE REPRISE T1 et RATTRAPAGE PERMANENT
-- (lot 115H, carte Trello #785 « T1 — fermer les écarts du lot 114H : plafonds
-- BO, reprises exactes, rattrapage permanent et bilan exhaustif », § 2, § 3,
-- § 4, § 5 et § 6).
--
--   · `t1_requeue_requests` : une ligne par DEMANDE de remise en file T1,
--     identifiée de façon stable et idempotente (`request_key`). C'est elle qui
--     rend le compteur de reprises exact quel que soit l'endroit où le
--     traitement s'arrête, et qui distingue « demande identique déjà vivante »
--     (constatée, aucun passage supplémentaire, aucune consommation) de
--     « demande réellement distincte » (identité propre, droit réservé,
--     consommation exacte) :
--       request_key        identité stable de la demande (compte + document +
--                          origine + empreinte des preuves) : deux clics, BO +
--                          planificateur ou deux exécutants portant la MÊME
--                          demande retrouvent la même ligne ;
--       evidence_fingerprint  empreinte des preuves / de la source au moment de
--                          la demande : une vraie nouveauté de source ou de
--                          preuve donne une demande DISTINCTE ;
--       state              RESERVED (droit réservé, enfilement en cours),
--                          CONFIRMED (travail vivant corrélé), OBSERVED
--                          (travail identique déjà vivant : rien de réservé),
--                          RELEASED (réservation rendue : aucune consommation),
--                          REFUSED (droit refusé avant tout enfilement),
--                          RECOVERED (réservation rendue par la reprise après
--                          panne) ;
--       reserved_attempt   valeur de `retry_attempts` prise par la réservation
--                          (NULL : aucune réservation) — permet de rendre
--                          EXACTEMENT ce qui avait été pris ;
--       job_id             travail corrélé (créé ou constaté vivant) ;
--       steps              frontières franchies (réservé, enfilé, compté,
--                          diagnostiqué) : la reprise après panne sait ce qui
--                          est acquis et ne consomme jamais deux fois.
--     `file_id` sans clé étrangère : la trace de la demande survit à la purge
--     du document. Suppression du compte : cascade par `account_id`.
--
--   · `t1_reassessment_cursors` : POINTS DE REPRISE DURABLES de la campagne de
--     réévaluation (un par version de règles et par nature de parcours :
--     documents, alertes). Sans eux, chaque passage repartait du début du stock
--     et les éléments de FIN de stock pouvaient ne jamais être atteints
--     (famine). Aucun contenu, aucun `account_id` : ce sont des curseurs de
--     campagne.
--
--   · `t1_coverage_reassessments` (migration 1705) complétée, additivement :
--       evidence_fingerprint  empreinte des preuves / données confrontées — un
--                          document n'est « à jour » que pour (version de
--                          règle, empreinte) : une preuve nouvelle à version
--                          constante le fait réexaminer, et une confrontation
--                          IDENTIQUE n'est jamais rejouée ;
--       steps              étapes acquises du document (re-vérification,
--                          réconciliation, alertes, journal) : reprise après
--                          panne entre deux écritures, sans perte de
--                          traçabilité ni double consommation ;
--       lease_owner / lease_expires_at  RÉSERVATION du document par la
--                          campagne : deux campagnes simultanées ne traitent
--                          jamais le même document ;
--       deferred_cause     cause d'un report (compte temporairement exclu,
--                          analyse en cours, reprise planifiée imminente) : le
--                          travail différé reste IDENTIFIABLE et réarmé dès que
--                          sa cause disparaît, sans attendre un redémarrage ni
--                          une consultation du BO.
--
-- Additive, idempotente, rejouable ; aucune reprise de données ici. Retour
-- arrière : DROP TABLE t1_requeue_requests, t1_reassessment_cursors et
-- ALTER TABLE t1_coverage_reassessments DROP COLUMN … (le code tolère leur
-- absence : il retombe sur le comportement du lot 114H).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

-- ── 1. Identité et réservation des demandes de reprise T1 ────────────────────
CREATE TABLE IF NOT EXISTS t1_requeue_requests (
  id                   BIGSERIAL    PRIMARY KEY,
  account_id           INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id              INTEGER      NOT NULL,
  request_key          TEXT         NOT NULL,
  origin               TEXT         NOT NULL,
  requested_by         TEXT         NOT NULL,
  evidence_fingerprint TEXT,
  state                TEXT         NOT NULL,
  reason               TEXT,
  reserved_attempt     INTEGER,
  attempt_consumed     BOOLEAN      NOT NULL DEFAULT FALSE,
  job_id               BIGINT,
  steps                JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS t1_requeue_requests_key_uidx
  ON t1_requeue_requests (account_id, file_id, request_key);
CREATE INDEX IF NOT EXISTS t1_requeue_requests_state_idx
  ON t1_requeue_requests (state, updated_at);
CREATE INDEX IF NOT EXISTS t1_requeue_requests_file_idx
  ON t1_requeue_requests (file_id);
CREATE INDEX IF NOT EXISTS t1_requeue_requests_account_idx
  ON t1_requeue_requests (account_id);

COMMENT ON TABLE t1_requeue_requests IS
  'Lot 115H (#785, § 2 et § 4) : identité persistante et idempotente d''une demande de remise en file T1, réservation du droit de reprise et frontières franchies — aucun contenu de document.';

-- ── 2. Points de reprise durables de la campagne de réévaluation ─────────────
CREATE TABLE IF NOT EXISTS t1_reassessment_cursors (
  rules_version  INTEGER      NOT NULL,
  kind           TEXT         NOT NULL,
  position       BIGINT       NOT NULL DEFAULT 0,
  cycles         INTEGER      NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (rules_version, kind)
);

COMMENT ON TABLE t1_reassessment_cursors IS
  'Lot 115H (#785, § 5) : points de reprise durables de la campagne de réévaluation T1 (documents, alertes) — pas de famine en fin de stock, reprise après panne.';

-- ── 3. Journal 1705 complété (empreinte des preuves, étapes, bail, report) ───
ALTER TABLE t1_coverage_reassessments ADD COLUMN IF NOT EXISTS evidence_fingerprint TEXT;
ALTER TABLE t1_coverage_reassessments ADD COLUMN IF NOT EXISTS steps JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE t1_coverage_reassessments ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE t1_coverage_reassessments ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE t1_coverage_reassessments ADD COLUMN IF NOT EXISTS deferred_cause TEXT;

CREATE INDEX IF NOT EXISTS t1_coverage_reassessments_fingerprint_idx
  ON t1_coverage_reassessments (rules_version, evidence_fingerprint);
CREATE INDEX IF NOT EXISTS t1_coverage_reassessments_lease_idx
  ON t1_coverage_reassessments (lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;

COMMENT ON COLUMN t1_coverage_reassessments.evidence_fingerprint IS
  'Lot 115H (#785, § 5) : empreinte des preuves / données confrontées. « Déjà traité pour vN » n''est « encore à jour » que si cette empreinte est inchangée.';
COMMENT ON COLUMN t1_coverage_reassessments.steps IS
  'Lot 115H (#785, § 4) : étapes acquises du document (re-vérification, réconciliation, alertes) — reprise après panne entre deux écritures.';
COMMENT ON COLUMN t1_coverage_reassessments.deferred_cause IS
  'Lot 115H (#785, § 5) : cause du report (compte temporairement exclu, analyse en cours, reprise planifiée imminente) — travail différé identifiable et réarmé sans redémarrage.';
