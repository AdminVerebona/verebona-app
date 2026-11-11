-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1650 : TCO — arbitrage sémantique T3 des montants non qualifiés
-- (lot 113AL, carte Trello #737, écart au CDC 82B / 111V, demande
-- `82B-t3-decision-tco`).
--
-- `economic_qualification_reviews` (nouvelle) : DEMANDE, MÉMOIRE et
-- DÉCISION de l'examen T3 (opération `t3_economic_qualification`, branche
-- ECONOMIC_QUALIFICATION du prompt maître T3, contrat
-- `t3-economic-qualification-v1`, bloc 31 du guide du PO) des montants CONNUS
-- d'un document restés sans nature dans le TCO d'un bien (ligne
-- NOT_QUALIFIED / THEME_UNKNOWN, ou montant de l'extract sans aucune ligne).
--   · clé : empreinte STABLE du contexte pertinent (montants du document,
--     version de son analyse, faits déjà comptés du bien, documents liés) —
--     UNE ligne par compte, document et empreinte : un contexte inchangé n'est
--     JAMAIS renvoyé à l'IA ; un contexte changé (preuve nouvelle) est une
--     autre empreinte (réexamen motivé, l'examen précédent reste en historique) ;
--   · demande (PENDING) posée SANS appel IA par le contrôle
--     COH-TCO-EXTRACTED-EXPENSES (campagne, contrôle ciblé à chaque document
--     analysé ou modifié) ; traitée HORS lecture par le passage T3 du compte
--     (file de consolidation), par lots bornés, sous verrou de ligne
--     (RUNNING) ; jamais à l'ouverture du TCO ;
--   · issue : décisions validées (DECIDED : `decisions` = effets par montant,
--     relus par le moteur TCO à chaque calcul), abstention (ABSTAINED),
--     confiance insuffisante (NOT_CERTAIN), sortie refusée par la validation
--     (REJECTED), échec technique (AI_FAILED, nouvel essai borné ; puis
--     TECHNICAL_WAIT, reprise quotidienne automatique), contrat absent du
--     prompt actif ou coupure (CONTRACT_PENDING, reprise automatique dès le
--     retour du contrat), objet disparu ou déjà arbitré (OBSOLETE), examen
--     remplacé par un examen plus récent du même document (SUPERSEDED) ;
--   · trace : sortie reçue, validation, preuves citées, versions du contrat,
--     du prompt et du modèle, identifiant de trace et coût de la passerelle,
--     état des lignes avant / après, déclencheur.
-- Une décision de l'utilisateur (`asset_cost_line_decisions`) prime toujours ;
-- aucune ligne n'est écrite ailleurs : le moteur existant recalcule.
--
-- Additive, idempotente, rejouable ; aucune reprise de données. Suppression du
-- compte : cascade. Retour arrière : DROP TABLE economic_qualification_reviews
-- (le TCO revient au comportement 111V : « Nature à confirmer »).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS economic_qualification_reviews (
  id                    BIGSERIAL    PRIMARY KEY,
  account_id            INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id              INTEGER      NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file_id               INTEGER      NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  fingerprint           TEXT         NOT NULL,
  status                TEXT         NOT NULL DEFAULT 'PENDING',
  trigger               TEXT         NOT NULL DEFAULT 'COHERENCE',
  amounts               JSONB        NOT NULL DEFAULT '[]'::jsonb,
  decisions             JSONB        NOT NULL DEFAULT '[]'::jsonb,
  reason                TEXT,
  ai_output             JSONB,
  validation            JSONB        NOT NULL DEFAULT '{}'::jsonb,
  lines_before          JSONB,
  lines_after           JSONB,
  contract_version      TEXT         NOT NULL,
  prompt_version        TEXT,
  model                 TEXT,
  ai_trace_id           TEXT,
  ai_cost_micros        BIGINT,
  ai_calls              INTEGER      NOT NULL DEFAULT 0,
  attempts              INTEGER      NOT NULL DEFAULT 0,
  retry_at              TIMESTAMPTZ,
  claimed_at            TIMESTAMPTZ,
  last_call_at          TIMESTAMPTZ,
  error                 TEXT,
  superseded_by         BIGINT,
  requested_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  decided_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'economic_qualification_reviews_status_chk') THEN
    ALTER TABLE economic_qualification_reviews ADD CONSTRAINT economic_qualification_reviews_status_chk
      CHECK (status IN ('PENDING', 'RUNNING', 'DECIDED', 'ABSTAINED', 'NOT_CERTAIN', 'REJECTED', 'AI_FAILED', 'TECHNICAL_WAIT',
                        'CONTRACT_PENDING', 'OBSOLETE', 'SUPERSEDED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'economic_qualification_reviews_trigger_chk') THEN
    ALTER TABLE economic_qualification_reviews ADD CONSTRAINT economic_qualification_reviews_trigger_chk
      CHECK (trigger IN ('COHERENCE', 'EVIDENCE_CHANGE', 'BACKFILL', 'BACKGROUND'));
  END IF;
END $$;

-- Mémoire : un seul examen par contexte (document + empreinte) d'un compte — jamais renvoyé à l'IA.
CREATE UNIQUE INDEX IF NOT EXISTS economic_qualification_reviews_fp_uidx
  ON economic_qualification_reviews (account_id, file_id, fingerprint);
-- File du passage T3 (demandes, nouveaux essais, attentes techniques ou de contrat).
CREATE INDEX IF NOT EXISTS economic_qualification_reviews_queue_idx
  ON economic_qualification_reviews (account_id, id)
  WHERE status IN ('PENDING', 'RUNNING', 'AI_FAILED', 'TECHNICAL_WAIT', 'CONTRACT_PENDING');
-- Lecture par le moteur TCO (examens conclus d'un document).
CREATE INDEX IF NOT EXISTS economic_qualification_reviews_file_idx
  ON economic_qualification_reviews (account_id, file_id, decided_at DESC);
