-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0676 : la campagne de pertinence « À traiter » (lots 61 / 72 / 76,
-- `l76-pertinence-1`) devient un contrôle du registre de cohérence (lot 83E —
-- arbitrages PO du 23/10/2026 C-Q9, §3.1 : une seule chaîne par fonction ; le
-- chemin remplacé est retiré dans la même livraison).
--
-- Le moteur de campagne (`runRelevanceCampaign`) est RETIRÉ du code : la
-- réévaluation des cartes et des décisions périmées est faite par les contrôles
-- COH-TODO-RELEVANCE-CARDS et COH-TODO-STALE-DECISIONS (même code métier :
-- décision centrale du pont documentaire, producteurs des familles « état »),
-- dans la campagne exhaustive quotidienne `coherence-control`.
--
-- HISTORIQUE CONSERVÉ ET LISIBLE : aucune campagne ni aucun élément n'est
-- supprimé (BO › File d'attente IA › Pertinence « À traiter », lecture seule).
-- Une campagne encore « en cours » est close avec le statut SUPERSEDED (elle
-- ne pourrait plus avancer) ; son périmètre porte la mention du contrôle qui
-- la remplace. Idempotente, rejouable. Retour arrière : le code antérieur lit
-- SUPERSEDED comme un statut terminal inconnu (affiché tel quel).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('to_process_relevance_campaigns') IS NOT NULL THEN
    ALTER TABLE to_process_relevance_campaigns DROP CONSTRAINT IF EXISTS to_process_relevance_campaigns_status_chk;
    ALTER TABLE to_process_relevance_campaigns ADD CONSTRAINT to_process_relevance_campaigns_status_chk
      CHECK (status IN ('RUNNING', 'DONE', 'DONE_WITH_ERRORS', 'ERROR', 'SUPERSEDED'));

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                 AND table_name = 'to_process_relevance_campaigns' AND column_name = 'scope') THEN
      UPDATE to_process_relevance_campaigns
         SET status = 'SUPERSEDED', finished_at = COALESCE(finished_at, now()),
             scope = COALESCE(scope, '{}'::jsonb) || jsonb_build_object(
               'supersededBy', 'contrôle de cohérence (COH-TODO-RELEVANCE-CARDS, COH-TODO-STALE-DECISIONS) — lot 83E',
               'supersededAt', now())
       WHERE status = 'RUNNING';
    ELSE
      UPDATE to_process_relevance_campaigns
         SET status = 'SUPERSEDED', finished_at = COALESCE(finished_at, now())
       WHERE status = 'RUNNING';
    END IF;

    COMMENT ON TABLE to_process_relevance_campaigns IS
      'Lots 61 / 72 / 76 : campagnes de pertinence « À traiter » — HISTORIQUE (lecture seule depuis le lot 83E : remplacées par les contrôles du registre de cohérence COH-TODO-RELEVANCE-CARDS et COH-TODO-STALE-DECISIONS).';
  END IF;
END $$;
