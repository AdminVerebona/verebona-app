-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0777 : provenance et état de preuve des configurations IA
-- existantes — lot 89A (CDC Pilotage IA V2, phase P8 : MIG-02 « pas de
-- qualification fictive » ; décision PO n° 06).
--
--   ai_config_versions.provenance_mark
--     Marque posée par le reclassement P8 sur chaque version MANUELLE
--     existante : { rule, runId, provenance: "manual", proof: "not_qualified",
--     label: "manuel, non qualifié", markedAt }. Affichage et traçabilité
--     SEULEMENT : aucun chemin d'exécution (résolveur, secours, routage,
--     qualification, import) ne la lit — le comportement des configurations
--     est inchangé. Une candidate automatique (origin = 'auto') n'est jamais
--     marquée (elle porte son propre cycle de preuve).
--
-- Écrite par la tâche interne `ai-history-reclassification` ou par le
-- rattrapage du BO, jamais par une commande ; `updated_at` de la version
-- n'est pas modifié (ce n'est pas une modification de configuration).
-- Additive, idempotente, aucune donnée existante modifiée.
-- Retour arrière : « Restaurer » du rattrapage remet la colonne à vide.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_config_versions ADD COLUMN IF NOT EXISTS provenance_mark JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_config_versions_provenance_mark_chk') THEN
    ALTER TABLE ai_config_versions ADD CONSTRAINT ai_config_versions_provenance_mark_chk
      CHECK (provenance_mark IS NULL OR jsonb_typeof(provenance_mark) = 'object') NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN ai_config_versions.provenance_mark IS
  'Lot 89A (Pilotage IA V2 P8, MIG-02) : version existante marquée « manuel, non qualifié » (provenance, état de preuve, règle, date). Affichage seulement : aucun effet sur l''exécution.';
