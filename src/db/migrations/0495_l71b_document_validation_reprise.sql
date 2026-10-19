-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0495 : journal de la reprise des documents « à valider »
-- (lot 71B — décision PO du 19/10 : plus de système de validation sur les fiches).
--
-- Depuis le lot 71B, aucun moteur ne met plus un document dans l'état
-- `VALIDATION_REQUIRED` (bandeau « Automatique — Validation suggérée » et
-- bouton « Appliquer » du tiroir supprimés) : une valeur fiable est écrite
-- directement, une valeur incertaine ou en conflit devient une carte
-- « À traiter ». Les documents restés dans cet état sont repris par la tâche
-- planifiée interne `document-validation-reprise` et par le rattrapage BO
-- (Exploitation › Rattrapages › « Documents « à valider » : reprise ») :
-- état remis à « analysé », données documentaires réévaluées par la décision
-- centrale du pont « À traiter » (écriture fiable ou carte), rattachement aux
-- équipements par les données structurées (ambiguïté → carte LINK-ELT).
--
-- Une ligne par document repris (unique) : identifiant d'exécution, origine
-- (tâche / BO), motif, état avant / après, propositions en attente au moment
-- de la reprise, bilan des moteurs. Une seconde reprise du même document
-- (cas théorique d'une ancienne instance pendant un déploiement progressif)
-- met la ligne à jour et incrémente `passes` : jamais de doublon.
--
-- Idempotente (IF NOT EXISTS). Table nouvelle, vide : aucun verrou sur une
-- table existante. Retour arrière : DROP TABLE (aucune donnée n'en dépend).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_validation_reprise (
  id                 bigserial PRIMARY KEY,
  file_id            integer NOT NULL,
  account_id         integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  run_id             uuid NOT NULL,
  origin             text NOT NULL,
  reason             text,
  before_state       text NOT NULL,
  after_state        text NOT NULL,
  pending_proposals  integer NOT NULL DEFAULT 0,
  rules              jsonb NOT NULL DEFAULT '{}'::jsonb,
  equipment          jsonb NOT NULL DEFAULT '{}'::jsonb,
  passes             integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_validation_reprise_origin_chk CHECK (origin IN ('SCHEDULED', 'BO'))
);

CREATE UNIQUE INDEX IF NOT EXISTS document_validation_reprise_file_uq ON document_validation_reprise (file_id);
CREATE INDEX IF NOT EXISTS document_validation_reprise_run_idx ON document_validation_reprise (run_id);
CREATE INDEX IF NOT EXISTS document_validation_reprise_account_idx ON document_validation_reprise (account_id, created_at DESC);

COMMENT ON TABLE document_validation_reprise IS
  'Lot 71B : documents sortis de l''ancien état « à valider » (VALIDATION_REQUIRED) — reprise par la tâche planifiée ou le BO, bilan des moteurs.';
