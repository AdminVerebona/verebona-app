-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0223 (suite) : liens source ↔ agenda (CDC 15 T4-07, X-04, §11).
--
-- `agenda_item_sources` était la trace du moteur d'analyse historique : une
-- ligne par effet d'un RUN d'analyse (`run_id` obligatoire). Le service
-- unique de liaison (`services/agenda/agenda-source-links.ts`) y inscrit
-- désormais aussi chaque document relié à un élément — source d'un élément
-- automatique, pièce jointe d'un élément manuel, preuve de réalisation :
--
--   · run_id        devient FACULTATIF : une pièce jointe n'a pas de run ;
--                   renseigné quand le document a été analysé (dernier run) ;
--   · source_role   SOURCE | ATTACHMENT | PROOF ; NULL = ligne historique ;
--   · evidence_id   preuve (`field_evidence`) à l'origine du lien, si connue ;
--   · effect_type   + 'linked' : lien posé par le service de liaison. Les
--                   valeurs historiques gardent leur sens — en particulier
--                   'created' (échéance créée par un run d'analyse), que les
--                   indicateurs d'administration comptent comme « créée par
--                   l'IA » : le service n'écrit jamais 'created'.
--
-- Schéma Drizzle : `run_id` facultatif et 'linked' déclarés ; `source_role`
-- et `evidence_id` NON déclarés (Drizzle cite toutes les colonnes déclarées
-- dans un INSERT : le moteur d'analyse historique échouerait si cette
-- migration manquait). Écrites en SQL après contrôle de présence
-- (`services/agenda/agenda-columns.ts`).
--
-- VERROUS : DROP NOT NULL et ADD COLUMN nullable = catalogue seul, sous
-- ACCESS EXCLUSIVE : `lock_timeout` 5 s. Contrainte remplacée NOT VALID (pas
-- de balayage), dans la même transaction. Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE agenda_item_sources
  ALTER COLUMN run_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source_role TEXT,
  ADD COLUMN IF NOT EXISTS evidence_id INTEGER;

ALTER TABLE agenda_item_sources DROP CONSTRAINT IF EXISTS agenda_item_sources_effect_type_check;
ALTER TABLE agenda_item_sources
  ADD CONSTRAINT agenda_item_sources_effect_type_check
  CHECK (effect_type IN ('created', 'resolved_existing', 'conflict_pending', 'rejected_orphan', 'linked')) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'agenda_item_sources_source_role_ck'
                    AND conrelid = 'agenda_item_sources'::regclass) THEN
    ALTER TABLE agenda_item_sources
      ADD CONSTRAINT agenda_item_sources_source_role_ck
      CHECK (source_role IS NULL OR source_role IN ('SOURCE', 'ATTACHMENT', 'PROOF')) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN agenda_item_sources.source_role IS
  'SOURCE | ATTACHMENT | PROOF (CDC 15 T4-07, X-04). NULL = trace historique d''un run d''analyse.';
COMMENT ON COLUMN agenda_item_sources.evidence_id IS
  'Preuve field_evidence à l''origine du lien, si connue.';
