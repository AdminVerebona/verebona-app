-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1590 : périodes métier — conformité au CDC #724 (lot 113AA, carte
-- Trello #725 « Corriger les écarts 113W/113W2 au CDC #724 et valider R01–R21 »).
--
-- (a) `document_business_periods` (1560) :
--     · deux natures qualifiées par T1 (contrat `t1-business-periods-v2`,
--       bloc 28 du guide du PO) : CONTRACT (effet contractuel : date d'effet,
--       fin contractuelle — jamais une couverture) et REALIZATION (travaux ou
--       prestation réellement exécutés — jamais un devis). La contrainte de
--       nature est ÉLARGIE (aucune valeur existante ne devient invalide) ;
--     · `end_open` : durée indéterminée ÉTABLIE par le document (la fin
--       n'existe pas), distincte d'une fin INCONNUE (`end_on` nul, `end_open`
--       faux). Jamais vrai avec une fin datée.
-- (b) `business_period_decisions` (nouvelle) : décision DURABLE de
--     l'utilisateur sur une divergence de périodes qu'aucune preuve
--     n'explique (D11, R14), posée par la carte « À traiter » PERIOD-CONFLICT
--     sur l'événement de référence concerné. Clé : empreinte STABLE de la
--     divergence (nature, documents, bornes) — un arbitrage tranché n'est
--     jamais redemandé ; une divergence nouvelle (bornes changées) est une
--     autre empreinte. KEEP : la période du document retenu est la bonne
--     (l'autre reste dans l'historique, « remplacée ») ; BOTH : les deux sont
--     justes. Historique : une décision remplacée passe SUPERSEDED (jamais
--     supprimée). Aucune période de document n'est modifiée par la décision.
--
-- Additive, idempotente, rejouable ; aucune reprise de données (le stock est
-- traité par les contrôles de cohérence COH-DOC-BUSINESS-PERIODS et
-- COH-OPS-PERIOD-RESOLUTION). Suppression du compte : cascade.
-- Retour arrière : DROP TABLE business_period_decisions ; DROP COLUMN
-- document_business_periods.end_open ; la contrainte élargie peut rester
-- (le code d'avant n'écrit que les cinq natures initiales).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

-- (a) Natures et durée indéterminée.
ALTER TABLE document_business_periods ADD COLUMN IF NOT EXISTS end_open BOOLEAN NOT NULL DEFAULT FALSE;

-- L'ancienne contrainte (cinq natures) est retirée à chaque passage : une base dont le schéma a été posé
-- avant la migration 1560 (schéma Drizzle puis migrations) la recevrait sinon de 1560.
ALTER TABLE document_business_periods DROP CONSTRAINT IF EXISTS document_business_periods_kind_chk;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_business_periods_kind_v2_chk') THEN
    ALTER TABLE document_business_periods ADD CONSTRAINT document_business_periods_kind_v2_chk
      CHECK (period_kind IN ('COVERAGE', 'BILLING', 'VALIDITY', 'WARRANTY', 'SERVICE', 'CONTRACT', 'REALIZATION'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_business_periods_open_end_chk') THEN
    ALTER TABLE document_business_periods ADD CONSTRAINT document_business_periods_open_end_chk
      CHECK (NOT end_open OR end_on IS NULL);
  END IF;
END $$;

-- (b) Décisions de l'utilisateur sur une divergence de périodes.
CREATE TABLE IF NOT EXISTS business_period_decisions (
  id                    BIGSERIAL    PRIMARY KEY,
  account_id            INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operation_id          BIGINT       NOT NULL REFERENCES business_operations(id) ON DELETE CASCADE,
  period_kind           TEXT         NOT NULL,
  fingerprint           TEXT         NOT NULL,
  choice                TEXT         NOT NULL,
  retained_file_id      INTEGER      REFERENCES asset_files(id) ON DELETE SET NULL,
  file_ids              INTEGER[]    NOT NULL DEFAULT '{}',
  evidence              JSONB        NOT NULL DEFAULT '{}'::jsonb,
  action_id             INTEGER,
  decided_by_user_id    INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  status                TEXT         NOT NULL DEFAULT 'ACTIVE',
  superseded_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_period_decisions_choice_chk') THEN
    ALTER TABLE business_period_decisions ADD CONSTRAINT business_period_decisions_choice_chk
      -- Le document retenu peut disparaître ensuite (SET NULL) : la décision devient alors sans objet (relue, jamais appliquée).
      CHECK (choice IN ('KEEP', 'BOTH') AND (choice = 'KEEP' OR retained_file_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_period_decisions_status_chk') THEN
    ALTER TABLE business_period_decisions ADD CONSTRAINT business_period_decisions_status_chk
      CHECK (status IN ('ACTIVE', 'SUPERSEDED') AND ((status = 'ACTIVE') = (superseded_at IS NULL)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_period_decisions_kind_chk') THEN
    ALTER TABLE business_period_decisions ADD CONSTRAINT business_period_decisions_kind_chk
      CHECK (period_kind IN ('COVERAGE', 'BILLING', 'VALIDITY', 'WARRANTY', 'SERVICE', 'CONTRACT', 'REALIZATION'));
  END IF;
END $$;

-- Une seule décision ACTIVE par divergence d'un événement de référence.
CREATE UNIQUE INDEX IF NOT EXISTS business_period_decisions_active_uidx
  ON business_period_decisions (account_id, operation_id, fingerprint) WHERE status = 'ACTIVE';
