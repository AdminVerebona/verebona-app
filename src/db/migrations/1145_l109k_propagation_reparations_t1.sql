-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1145 : journal de PROPAGATION des réparations T1 vers les
-- candidats « événement de référence » du document et vers T3 (lot 109K,
-- ticket « T1 couverture PDF + propagation », COR-02).
--
-- Une réparation ciblée T1 (reprise de couverture, réexamen) AJOUTE des faits
-- sans réécrire l'existant. Si un fait ajouté modifie l'interprétation métier
-- (montant, date, référence, prestataire, cible, nature, preuve de
-- réalisation), les candidats ACTIFS du document sont réévalués de façon
-- DÉTERMINISTE (aucun appel IA) ; un candidat dont l'état pertinent change est
-- SUPERSÉDÉ par une nouvelle version (même clé, même transaction) et T3 est
-- signalé UNE fois pour cet état. Ce journal trace chaque décision :
--
--   decision      NO_NEW_FACT        aucun fait nouveau ;
--                 NO_BUSINESS_IMPACT faits nouveaux sans incidence métier ;
--                 NO_CANDIDATE       aucun candidat actif (T1 ne crée jamais
--                                    d'événement de référence) ;
--                 UNCHANGED          réévaluation sans changement d'état ;
--                 DUPLICATE_STATE    état déjà signalé à T3 (déduplication) ;
--                 RATE_LIMITED       plafond de fréquence atteint ;
--                 SUPERSEDED         nouvelle version écrite, T3 signalé ;
--   state_fingerprint  empreinte de l'état pertinent du candidat (unique par
--                      fichier, clé et décision SUPERSEDED : un même état
--                      n'est jamais signalé deux fois) ;
--   new_fact_ids, categories, changes : faits nouveaux, catégories, mutations ;
--   t3_status     REQUESTED / NOT_REQUESTED / NONE, t3_job_id.
--
-- Aucun contenu de document : identifiants, codes, empreintes.
-- Additive, idempotente, aucune reprise de données. Suit le document lors d'un
-- changement de compte (asset-account-transfer : `file_id`), supprimée avec le
-- compte ou le document (ON DELETE CASCADE). Table neuve : index créés ici.
-- Retour arrière : DROP TABLE IF EXISTS document_candidate_repair_propagations
-- (une réparation ne réévalue plus les candidats, comme avant le lot 109K).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_candidate_repair_propagations (
  id                    BIGSERIAL   PRIMARY KEY,
  account_id            INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id               INTEGER     NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  origin                TEXT        NOT NULL,
  decision              TEXT        NOT NULL,
  reason                TEXT,
  candidate_key         TEXT,
  previous_candidate_id BIGINT,
  candidate_id          BIGINT,
  state_fingerprint     TEXT,
  new_fact_ids          BIGINT[]    NOT NULL DEFAULT '{}',
  categories            TEXT[]      NOT NULL DEFAULT '{}',
  changes               TEXT[]      NOT NULL DEFAULT '{}',
  t3_status             TEXT        NOT NULL DEFAULT 'NONE',
  t3_job_id             BIGINT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_candidate_repair_propagations_decision_chk CHECK (decision IN (
    'NO_NEW_FACT', 'NO_BUSINESS_IMPACT', 'NO_CANDIDATE', 'UNCHANGED', 'DUPLICATE_STATE', 'RATE_LIMITED', 'SUPERSEDED')),
  CONSTRAINT document_candidate_repair_propagations_t3_chk CHECK (t3_status IN ('NONE', 'REQUESTED', 'NOT_REQUESTED'))
);

-- Déduplication : un état pertinent d'un candidat n'est signalé à T3 qu'une fois.
CREATE UNIQUE INDEX IF NOT EXISTS document_candidate_repair_propagations_state_uidx
  ON document_candidate_repair_propagations (file_id, candidate_key, state_fingerprint)
  WHERE decision = 'SUPERSEDED';
-- Plafond de fréquence (fenêtre glissante par document) et lecture du diagnostic.
CREATE INDEX IF NOT EXISTS document_candidate_repair_propagations_file_idx
  ON document_candidate_repair_propagations (file_id, created_at DESC);
CREATE INDEX IF NOT EXISTS document_candidate_repair_propagations_account_idx
  ON document_candidate_repair_propagations (account_id, created_at DESC);

COMMENT ON TABLE document_candidate_repair_propagations IS
  'Lot 109K : propagation des réparations T1 vers les candidats du document et T3 (décision, faits nouveaux, catégories, mutations, supersession, statut T3). Historique conservé.';
