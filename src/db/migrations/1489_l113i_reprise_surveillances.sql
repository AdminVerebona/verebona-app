-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1489 : reprise des surveillances post-activation historiques (lot
-- 113I, CDC V2 DATA-07, SQL-003, SQL-010).
--
-- L'ancienne règle (lot 105B) clôturait la surveillance à la fin de la fenêtre
-- de 72 h (« RESOLVED »), y compris faute de données : cette règle est abrogée
-- (MON-01/02 : la fenêtre est un jalon, jamais une échéance). Les candidates
-- ACTIVÉES dont la surveillance ne peut pas être reconstituée sans ambiguïté
-- reçoivent l'état explicite LEGACY_OBSERVATION_UNKNOWN :
--   · ACTIVATED sans suivi `watch` ;
--   · ACTIVATED clôturées RESOLVED par l'ancienne règle.
-- Jamais VALIDATED_IN_USAGE rétroactif, aucun retour arrière, aucune donnée
-- supprimée : l'ancien état est conservé dans `watch.legacy`. Déterministe et
-- idempotente (ne touche que les lignes pas encore reprises).
-- Retour arrière : sans objet (l'état antérieur reste lisible dans `watch.legacy`).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('ai_config_versions') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                  AND table_name = 'ai_config_versions' AND column_name = 'candidate_promotion') THEN
    UPDATE ai_config_versions
       SET candidate_promotion = candidate_promotion || jsonb_build_object('watch',
             COALESCE(candidate_promotion->'watch', '{}'::jsonb)
             || jsonb_build_object('status', 'LEGACY_OBSERVATION_UNKNOWN',
                                   'legacy', COALESCE(candidate_promotion->'watch', 'null'::jsonb),
                                   'legacyNote', 'Surveillance antérieure au lot 113I non reconstituable sans ambiguïté (ancienne clôture par fenêtre) : aucun retour arrière, aucune validation rétroactive.'))
     WHERE origin = 'auto' AND candidate_state = 'ACTIVATED'
       AND (candidate_promotion->'watch' IS NULL OR candidate_promotion->'watch'->>'status' = 'RESOLVED');
  END IF;
END $$;
