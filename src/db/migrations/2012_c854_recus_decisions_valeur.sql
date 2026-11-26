-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 2012 : JOURNAL DES RÉCEPTIONS DE DÉCISIONS DE VALEUR T1 (carte
-- Trello #854, P1-02 de #835 — réparations différées).
--
-- `document_value_decision_receipts` : UNE ligne par décision de valeur REÇUE
-- d'un appel T1 d'une passe de réparation différée (manuelle, planifiée,
-- continuation, contrôle de cohérence), AVANT toute validation :
--   · identité stable de réception : passe (`pass_id`), appel (`call_index`,
--     identifiant de trace de la passerelle `call_ref` s'il existe — jamais
--     inventé), rang de la décision dans la réponse (`ordinal`) →
--     `receipt_key` unique (rejeu identique : aucun doublon) ;
--   · contrat RÉELLEMENT consommé par l'appel (état, version du contrat,
--     version et empreinte du prompt, version de configuration) ;
--   · issue : PENDING (manifeste écrit, non encore évaluée), VALID, INVALID
--     (rejet de validation), REJECTED (rejet avant validation : schéma, unité
--     hors zone, contrat absent / incompatible), NOT_EVALUATED (incident
--     technique réessayable : contexte illisible, écriture ou relecture en
--     échec, référence invalidée au commit) — motif dans `reason` ;
--   · écriture : lien à la décision persistée (`decision_id`, `decision_fp`),
--     état NEW / ALREADY_PRESENT / CONFIRMED / MISSING / DIVERGENT /
--     UNCONFIRMED / NOT_APPLICABLE ; compteur de reprises sans IA bornée ;
--   · `payload` : la décision reçue et les faits de la réponse qu'elle cite
--     (reprise de la persistance SANS nouvel appel IA après un crash).
--
-- Jamais de suppression par le code (historique) ; supprimée avec le compte ou
-- le document (ON DELETE CASCADE), suit le document lors d'un changement de
-- compte (asset-account-transfer : `file_id`). Aucun prompt, aucune donnée
-- d'un autre compte.
--
-- Additive, idempotente, rejouable ; table neuve (index créés ici). Aucune
-- reprise de données : les décisions historiques n'ont pas de réception —
-- leur identité d'appel reste NON VÉRIFIABLE (jamais reconstruite).
-- Retour arrière : DROP TABLE IF EXISTS document_value_decision_receipts (la
-- reprise différée signale alors le journal absent : décisions non évaluées,
-- aucune décision acceptée sans trace).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_value_decision_receipts (
  id                 BIGSERIAL   PRIMARY KEY,
  account_id         INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id            INTEGER     NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  extraction_id      BIGINT,
  pass_id            TEXT        NOT NULL,
  pass_origin        TEXT        NOT NULL,
  call_index         INTEGER     NOT NULL,
  call_ref           TEXT,
  ordinal            INTEGER     NOT NULL,
  receipt_key        TEXT        NOT NULL,
  contract_state     TEXT        NOT NULL,
  contract_version   TEXT,
  prompt_version     TEXT,
  prompt_fingerprint TEXT,
  config_version_id  BIGINT,
  decision_type      TEXT,
  source_unit_id     TEXT,
  outcome            TEXT        NOT NULL DEFAULT 'PENDING',
  reason             TEXT,
  retryable          BOOLEAN     NOT NULL DEFAULT false,
  decision_fp        TEXT,
  decision_id        BIGINT,
  write_state        TEXT        NOT NULL DEFAULT 'PENDING',
  recovery_attempts  INTEGER     NOT NULL DEFAULT 0,
  payload            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_value_decision_receipts_outcome_chk CHECK (outcome IN ('PENDING', 'VALID', 'INVALID', 'REJECTED', 'NOT_EVALUATED')),
  CONSTRAINT document_value_decision_receipts_write_chk CHECK (write_state IN ('PENDING', 'NEW', 'ALREADY_PRESENT', 'CONFIRMED', 'MISSING', 'DIVERGENT', 'UNCONFIRMED', 'NOT_APPLICABLE')),
  CONSTRAINT document_value_decision_receipts_contract_chk CHECK (contract_state IN ('CARRIED', 'MARKER_MISSING', 'UNSUPPORTED_VERSION', 'EVIDENCE_MISSING')),
  CONSTRAINT document_value_decision_receipts_type_chk CHECK (decision_type IS NULL OR decision_type IN ('STRUCTURED', 'COMPONENT_OR_CONTEXT', 'NOT_RETAINED', 'UNDETERMINED')),
  CONSTRAINT document_value_decision_receipts_payload_chk CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT document_value_decision_receipts_reason_chk CHECK (outcome IN ('PENDING', 'VALID') OR reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS document_value_decision_receipts_key_uidx
  ON document_value_decision_receipts (receipt_key);
CREATE INDEX IF NOT EXISTS document_value_decision_receipts_file_idx
  ON document_value_decision_receipts (file_id, pass_id);
CREATE INDEX IF NOT EXISTS document_value_decision_receipts_pending_idx
  ON document_value_decision_receipts (file_id, outcome, write_state);
CREATE INDEX IF NOT EXISTS document_value_decision_receipts_decision_idx
  ON document_value_decision_receipts (decision_id) WHERE decision_id IS NOT NULL;

COMMENT ON TABLE document_value_decision_receipts IS
  'Carte #854 : réception de chaque décision de valeur T1 d''une réparation différée — appel, contrat consommé, issue (VALID / INVALID / REJECTED / NOT_EVALUATED + motif), lien à la décision persistée, relecture exacte, reprise sans IA. Historique, jamais supprimé par le code.';
COMMENT ON COLUMN document_value_decision_receipts.call_ref IS
  'Identifiant de trace de la passerelle pour l''appel (ai_call_traces) ; NULL s''il n''a pas été rendu — jamais inventé.';
COMMENT ON COLUMN document_value_decision_receipts.write_state IS
  'CONFIRMED : relue en base, identique à l''attendu ; UNCONFIRMED : écrite mais relecture impossible (ne justifie aucune couverture) ; MISSING / DIVERGENT : écart de relecture.';
