-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1705 : JOURNAL de la réévaluation de la couverture T1 du stock
-- (lot 114H, carte Trello #775 « T1 — Fiabiliser les reprises, réévaluer les
-- documents historiques et purger les alertes obsolètes »).
--
--   · `t1_coverage_reassessments` : une ligne par (document, version des
--     règles de couverture / d'alerte T1). Écrite par la tâche planifiée
--     `t1-coverage-reassessment` (aucun appel IA) après le recalcul de la
--     couverture d'un document déjà analysé :
--       rules_version  version des règles (`T1_COVERAGE_RULES_VERSION`) —
--                      augmentée par tout correctif T1 qui change la condition
--                      d'une alerte : le stock est alors réévalué de nouveau ;
--       outcome        RESOLVED (devenue complète), RECONCILED (unités
--                      requalifiées sur preuve), REPAIR_SCHEDULED (lacune
--                      réparable : reprise ciblée programmée, plafonds
--                      normaux), STILL_UNRESOLVED (part non structurée
--                      conservée), UNVERIFIABLE (vérification incomplète
--                      conservée), FINAL_GAP (lacune réelle sans reprise
--                      admissible), UNCHANGED, ERROR ;
--       state_before / state_after  état AVANT et APRÈS : état de qualité, anomalies,
--                      compteurs d'unités, reprise programmée, tentatives —
--                      jamais de contenu de document ;
--       alerts         alertes de Supervision closes, maintenues ou ouvertes
--                      (empreinte, identifiant, action, cause) ;
--       detail         unités requalifiées (nombre, par règle), attentes
--                      levées, re-vérification des pages, actions admissibles ;
--       attempts       essais (une erreur est retentée, bornée).
--     C'est aussi le POINT DE REPRISE de la campagne : un document journalisé
--     pour une version n'est jamais retraité (lot interrompu → reprise sans
--     double traitement). `file_id` sans clé étrangère : le journal survit à
--     la purge du document. Suppression du compte : cascade par `account_id`.
--
-- Additive, idempotente, rejouable ; aucune reprise de données ici (la tâche
-- planifiée s'en charge au démarrage). Retour arrière :
--   DROP TABLE t1_coverage_reassessments (le code ignore son absence : la
--   tâche est alors sans effet).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS t1_coverage_reassessments (
  id             BIGSERIAL    PRIMARY KEY,
  account_id     INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id        INTEGER      NOT NULL,
  rules_version  INTEGER      NOT NULL,
  outcome        TEXT         NOT NULL,
  state_before   JSONB        NOT NULL DEFAULT '{}'::jsonb,
  state_after    JSONB        NOT NULL DEFAULT '{}'::jsonb,
  alerts         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  detail         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  error          TEXT,
  attempts       INTEGER      NOT NULL DEFAULT 1,
  duration_ms    INTEGER      NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS t1_coverage_reassessments_file_version_uidx
  ON t1_coverage_reassessments (file_id, rules_version);
CREATE INDEX IF NOT EXISTS t1_coverage_reassessments_version_outcome_idx
  ON t1_coverage_reassessments (rules_version, outcome);
CREATE INDEX IF NOT EXISTS t1_coverage_reassessments_account_idx
  ON t1_coverage_reassessments (account_id);

COMMENT ON TABLE t1_coverage_reassessments IS
  'Lot 114H (#775) : journal et point de reprise de la réévaluation sans IA de la couverture T1 du stock (avant / après, alertes closes ou maintenues) — aucun contenu de document.';
