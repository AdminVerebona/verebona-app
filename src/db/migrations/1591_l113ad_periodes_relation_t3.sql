-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1591 : périodes métier — réexamen T3 par l'IA d'une divergence de
-- périodes que les documents ne déclarent pas (lot 113AD, carte Trello #725,
-- décision D11 de #724, R13 / R14).
--
-- `business_period_relation_reviews` (nouvelle) : MÉMOIRE de l'examen T3
-- (opération `t3_period_relation`, branche PERIOD_RELATION du prompt maître
-- T3, contrat `t3-period-relation-v1`, bloc 29 du guide du PO) d'une PAIRE de
-- périodes divergentes d'un événement de référence.
--   · clé : empreinte STABLE de la divergence (`conflictFingerprint` de
--     `documents/business-periods/resolution.ts` : nature, documents, bornes),
--     UNE ligne par compte et par empreinte — une paire déjà classée n'est
--     jamais renvoyée à l'IA ; des bornes changées sont une autre empreinte ;
--   · demande (PENDING) posée par la synchronisation des cartes PERIOD-CONFLICT,
--     SANS appel IA, seulement si le prompt T3 actif porte la branche et le
--     marqueur ; traitée HORS lecture par le passage T3 du compte (file de
--     consolidation), par lots bornés ; jamais à la consultation ;
--   · issue : classement certain validé (DECIDED : succession, même fait,
--     natures différentes, avenant, rectificatif, contradiction), abstention,
--     sortie refusée par la validation (REJECTED), confiance insuffisante
--     (NOT_CERTAIN), échec technique (AI_FAILED, nouvel essai borné), objet
--     disparu (OBSOLETE), branche retirée du prompt (UNAVAILABLE) ;
--   · trace : sortie reçue, validation, preuve citée (document + extrait),
--     version du prompt, identifiant de trace de la passerelle (coût et
--     exécution : `ai_usage_event`, `ai_call_diagnostics`).
-- Une décision de l'utilisateur (`business_period_decisions`, 1590) prime
-- toujours ; aucune période de document n'est modifiée par cette table.
--
-- Additive, idempotente, rejouable ; aucune reprise de données. Suppression du
-- compte : cascade. Retour arrière : DROP TABLE business_period_relation_reviews
-- (la résolution revient au comportement 113AA : question ou signalement).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS business_period_relation_reviews (
  id                    BIGSERIAL    PRIMARY KEY,
  account_id            INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operation_id          BIGINT       NOT NULL REFERENCES business_operations(id) ON DELETE CASCADE,
  period_kind           TEXT         NOT NULL,
  fingerprint           TEXT         NOT NULL,
  file_ids              INTEGER[]    NOT NULL DEFAULT '{}',
  period_ids            BIGINT[]     NOT NULL DEFAULT '{}',
  status                TEXT         NOT NULL DEFAULT 'PENDING',
  relation              TEXT,
  replacing_file_id     INTEGER      REFERENCES asset_files(id) ON DELETE SET NULL,
  confidence            TEXT,
  evidence              JSONB        NOT NULL DEFAULT '[]'::jsonb,
  reason                TEXT,
  ai_output             JSONB,
  validation            JSONB        NOT NULL DEFAULT '{}'::jsonb,
  contract_version      TEXT         NOT NULL,
  decider_version       TEXT,
  ai_trace_id           TEXT,
  ai_calls              INTEGER      NOT NULL DEFAULT 0,
  attempts              INTEGER      NOT NULL DEFAULT 0,
  retry_at              TIMESTAMPTZ,
  last_call_at          TIMESTAMPTZ,
  error                 TEXT,
  requested_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  decided_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_period_relation_reviews_status_chk') THEN
    ALTER TABLE business_period_relation_reviews ADD CONSTRAINT business_period_relation_reviews_status_chk
      CHECK (status IN ('PENDING', 'DECIDED', 'ABSTAINED', 'REJECTED', 'NOT_CERTAIN', 'AI_FAILED', 'OBSOLETE', 'UNAVAILABLE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_period_relation_reviews_relation_chk') THEN
    ALTER TABLE business_period_relation_reviews ADD CONSTRAINT business_period_relation_reviews_relation_chk
      CHECK (relation IS NULL OR relation IN ('SUCCESSION', 'SAME_FACT', 'AMENDMENT', 'RECTIFICATION', 'DIFFERENT_NATURES', 'CONTRADICTION', 'ABSTAIN'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_period_relation_reviews_kind_chk') THEN
    ALTER TABLE business_period_relation_reviews ADD CONSTRAINT business_period_relation_reviews_kind_chk
      CHECK (period_kind IN ('COVERAGE', 'BILLING', 'VALIDITY', 'WARRANTY', 'SERVICE', 'CONTRACT', 'REALIZATION'));
  END IF;
END $$;

-- Mémoire : une seule ligne par divergence d'un compte (jamais renvoyée à l'IA une fois classée).
CREATE UNIQUE INDEX IF NOT EXISTS business_period_relation_reviews_fp_uidx
  ON business_period_relation_reviews (account_id, fingerprint);
-- File du passage T3 (demandes en attente, nouveaux essais échus).
CREATE INDEX IF NOT EXISTS business_period_relation_reviews_queue_idx
  ON business_period_relation_reviews (account_id, id) WHERE status IN ('PENDING', 'AI_FAILED');
