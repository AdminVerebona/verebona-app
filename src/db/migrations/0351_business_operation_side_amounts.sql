-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0351 : montants CONNUS hors total d'une Opération (lot 53D —
-- retour PO D9 « Achat » du 12/10/2026, cohérence D2 / Q16 / D9).
--
--   business_operation_side_amounts
--       Montants tracés à leurs sources mais JAMAIS comptés dans un total :
--         · ANCILLARY_FEE           frais annexes d'un achat facturés à part
--                                   (livraison, mise en service, frais de
--                                   dossier, immatriculation…) — préservés
--                                   distinctement pour le futur CDC TCO ;
--         · DOCUMENT_AMOUNT_DIFFERS prix (ou prix de vente) d'un document qui
--                                   diffère de la valeur SAISIE sur la fiche :
--                                   la saisie reste la référence, l'écart est
--                                   exposé au lieu d'être effacé en silence.
--       Écrite par T3 (consolidation de l'Opération, idempotente) ; aucun
--       agrégat existant ne lit cette table : aucun double compte possible.
--       `source_ids` : sources `business_operation_sources` qui portent le
--       montant (même compte, contrôlé par la consolidation).
--
-- Table neuve et vide : index créés ici (aucune table existante verrouillée).
-- Non déclarée dans Drizzle (même choix que 0223 / 0337 / 0338) : le code
-- tolère son absence (rien n'est écrit ni exposé, comportement antérieur).
-- Idempotente. Retour arrière : DROP TABLE IF EXISTS business_operation_side_amounts
-- (code tolérant).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS business_operation_side_amounts (
  id                BIGSERIAL    PRIMARY KEY,
  account_id        INTEGER      NOT NULL,
  operation_id      BIGINT       NOT NULL,
  nature            TEXT         NOT NULL,
  kind              TEXT         NOT NULL,
  fingerprint       TEXT         NOT NULL,
  amount_minor      BIGINT       NOT NULL,
  currency          CHAR(3)      NOT NULL,
  amount_eur_cents  BIGINT,
  economic_date     DATE,
  source_ids        BIGINT[]     NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT business_operation_side_amounts_operation_fk FOREIGN KEY (operation_id, account_id)
    REFERENCES business_operations(id, account_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT business_operation_side_amounts_nature_chk CHECK (nature IN ('ANCILLARY_FEE', 'DOCUMENT_AMOUNT_DIFFERS')),
  CONSTRAINT business_operation_side_amounts_kind_chk CHECK (kind IN ('FORECAST_COST', 'REALIZED_COST', 'REDUCTION', 'REFUND', 'INDEMNITY', 'PROCEED')),
  CONSTRAINT business_operation_side_amounts_amount_chk CHECK (amount_minor >= 0),
  CONSTRAINT business_operation_side_amounts_eur_chk CHECK (amount_eur_cents IS NULL OR amount_eur_cents >= 0),
  CONSTRAINT business_operation_side_amounts_currency_chk CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS business_operation_side_amounts_identity_uidx
  ON business_operation_side_amounts (operation_id, nature, fingerprint);
CREATE INDEX IF NOT EXISTS business_operation_side_amounts_account_idx
  ON business_operation_side_amounts (account_id);
