-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0752 : journal des RÉÉVALUATIONS SÉMANTIQUES T3 / T4 (lot 87B,
-- ticket P1 « Code — compléter l'orchestration T3/T4 et la réévaluation
-- sémantique », CODE-02, CODE-05 à CODE-11).
--
-- `operation_semantic_reevaluations` : une ligne par demande de nouvelle
-- décision sémantique sur une Opération —
--   scope T3  identité de l'Opération (rapprochement M3 existant, verdict
--             historique écarté quand il est suspect, CODE-06) ;
--   scope T4  représentation Agenda de l'Opération (plusieurs éléments
--             examinés ensemble : doublons, étapes, rattachements,
--             principal ; CODE-03).
-- Elle porte le déclencheur (contrôle de cohérence, projection après une
-- décision T3, reprise du stock, geste d'exploitation), le contexte transmis
-- (résumé borné et empreinte), la décision IA REÇUE, le résultat de la
-- validation serveur (refus et motifs), les rôles décidés par élément
-- (`decided_items` : identifiant → PRINCIPAL / STEP / INDEPENDENT /
-- DUPLICATE, décisions certaines seulement — lus par la projection pour ne
-- plus redemander ni proposer ce que T4 a tranché), les mutations APPLIQUÉES et
-- REFUSÉES, l'état avant / après, l'empreinte de l'état obtenu (convergence :
-- une décision appliquée n'est jamais redemandée sur ce même état, CODE-11).
-- Rôle :
--   · mémoire anti-rappel : même contexte, même version de contrat → aucune
--     nouvelle demande (une décision refusée n'est pas resoumise telle quelle) ;
--   · budget : appels du compte sur 24 h (plafonds existants du rapprochement
--     sémantique) ;
--   · diagnostics BO / export de recette (décisions et mutations visibles).
-- Aucune écriture métier ici : les mutations passent par les services
-- existants (regroupement 82D, consolidation d'agenda 76H, restauration 0591).
--
-- Additive, idempotente, aucune reprise de données. Aucune clé étrangère vers
-- les Opérations : le journal survit à la fusion, à la purge / reconstruction
-- (85A). RESTAURÉ avec les données lors du retour à un point de sauvegarde
-- (mémoire liée à l'état des éléments : jamais conservée « courante »).
-- Index de lecture : 0752_..._idx_1.
-- Retour arrière : DROP TABLE IF EXISTS operation_semantic_reevaluations.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS operation_semantic_reevaluations (
  id                     BIGSERIAL   PRIMARY KEY,
  account_id             INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scope                  TEXT        NOT NULL,
  operation_id           BIGINT,
  operation_ids          BIGINT[]    NOT NULL DEFAULT '{}',
  trigger_kind           TEXT        NOT NULL,
  trigger_ref            TEXT,
  correlation_id         TEXT,
  status                 TEXT        NOT NULL,
  reason                 TEXT,
  contract_version       TEXT        NOT NULL DEFAULT '',
  decider_version        TEXT        NOT NULL DEFAULT '',
  context_fingerprint    TEXT,
  resulting_fingerprint  TEXT,
  context_summary        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ai_output              JSONB,
  validation             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  decided_items          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  mutations_applied      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  mutations_refused      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  before_state           JSONB,
  after_state            JSONB,
  ai_calls               INTEGER     NOT NULL DEFAULT 0,
  ai_trace_id            TEXT,
  error                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at             TIMESTAMPTZ,
  CONSTRAINT operation_semantic_reevaluations_scope_chk CHECK (scope IN ('T3', 'T4')),
  CONSTRAINT operation_semantic_reevaluations_trigger_chk CHECK (trigger_kind IN ('COHERENCE', 'PROJECTION', 'T3_DECISION', 'REPRISE', 'MANUAL')),
  CONSTRAINT operation_semantic_reevaluations_status_chk CHECK (status IN (
    'PENDING', 'UNAVAILABLE', 'DEFERRED', 'AI_FAILED', 'REJECTED', 'APPLIED', 'PARTIAL', 'NO_CHANGE', 'ABSTAINED', 'FAILED')),
  CONSTRAINT operation_semantic_reevaluations_calls_chk CHECK (ai_calls >= 0),
  CONSTRAINT operation_semantic_reevaluations_json_chk CHECK (
    jsonb_typeof(context_summary) = 'object' AND jsonb_typeof(validation) = 'object' AND jsonb_typeof(decided_items) = 'object'
    AND jsonb_typeof(mutations_applied) = 'array' AND jsonb_typeof(mutations_refused) = 'array')
);

COMMENT ON TABLE operation_semantic_reevaluations IS
  'Lot 87B : réévaluations sémantiques T3 (identité) / T4 (représentation Agenda) d''une Opération — déclencheur, contexte, décision IA reçue, validation, mutations appliquées / refusées, état avant / après ; jamais une écriture métier.';
