-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0729 : exclusions de modèles et gels de configuration manuels
-- (lot 86B, CDC Pilotage IA V2 phase P6 : ACT-03, DEC-03, VER-06, R55).
--
--   · EXCLUSION : un administrateur retire un modèle de l'exécution (tous les
--                 traitements, ou un traitement) ; prime sur la configuration
--                 et sur toute optimisation jusqu'à sa levée ou au prochain
--                 import complet (qui la lève, signalée avant confirmation) ;
--   · FREEZE    : gel de la configuration (global ou un traitement) : aucun
--                 changement AUTOMATIQUE (promotion de routage, activation de
--                 candidate) tant qu'il dure ; même règle de levée.
-- Historisées (jamais supprimées) : création, levée, motif de levée
-- (`admin` / `import`), import responsable. Configuration IA : exclue de
-- l'export de recette ; restaurée avec la configuration. Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_config_interventions (
  id               BIGSERIAL   PRIMARY KEY,
  environment      TEXT        NOT NULL,
  kind             TEXT        NOT NULL,
  model            TEXT,
  treatment        TEXT,
  reason           TEXT        NOT NULL,
  created_by       INTEGER,
  created_by_email TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lifted_at        TIMESTAMPTZ,
  lifted_by        INTEGER,
  lift_reason      TEXT,
  import_id        BIGINT      REFERENCES ai_config_imports(id),
  CONSTRAINT ai_config_interventions_kind_check CHECK (kind IN ('EXCLUSION', 'FREEZE')),
  CONSTRAINT ai_config_interventions_model_check CHECK ((kind = 'EXCLUSION') = (model IS NOT NULL)),
  CONSTRAINT ai_config_interventions_lift_check CHECK (lifted_at IS NULL OR lift_reason IN ('admin', 'import'))
);

-- Une seule intervention ACTIVE par portée (table neuve : création directe).
CREATE UNIQUE INDEX IF NOT EXISTS ai_config_interventions_active_uidx
  ON ai_config_interventions (environment, kind, COALESCE(model, ''), COALESCE(treatment, ''))
  WHERE lifted_at IS NULL;

COMMENT ON TABLE ai_config_interventions IS
  'Lot 86B — exclusions de modèles et gels de configuration manuels (priorité, levés par un import complet).';
