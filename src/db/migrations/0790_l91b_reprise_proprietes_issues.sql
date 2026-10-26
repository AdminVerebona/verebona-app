-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0790 : toute issue de la reprise des propriétés manquantes est
-- PERSISTÉE (lot 91B, ticket P1 « Garantir l'exécution de la reprise des
-- propriétés manquantes et supprimer les sorties silencieuses »).
--
-- Jusqu'ici `property_recovery_runs` (0770) ne recevait une ligne qu'après
-- un appel T3 (ou un contexte vide) : contrat T3 absent, campagne à blanc,
-- nouvelle tentative pas encore due, pannes répétées, anti-boucle ou objet
-- jamais sélectionné ne laissaient AUCUNE trace dans le journal 88B.
--
-- Ajouts (additifs, idempotents, aucune reprise de données) :
--   · `cause`          cause explicite de l'issue (code + précision bornée) ;
--   · `contract_state` état du contrat T3 au moment de l'issue (CARRIED,
--                      MARKER_MISSING, BRANCH_MISSING, DISABLED, UNREADABLE) ;
--   · `campaign_id`    campagne de cohérence (sans clé étrangère : les
--                      campagnes sont purgées après 120 jours, la trace reste) ;
--   · statuts admis élargis : issues AVANT l'appel T3 (`CONTRACT_PENDING`,
--     `RETRY_SCHEDULED`, `DRY_RUN`, `REPAIR_SUPPRESSED`, `NOT_SELECTED`,
--     `NOT_EXECUTED`, `MEMORY_UNAVAILABLE`). Ces lignes « d'issue » ont une
--     empreinte de lot préfixée `gate:` : elles ne remplacent jamais une
--     analyse T3 (ni son compteur de tentatives, ni ses appels).
--
-- La contrainte de statut est remplacée par une contrainte PLUS LARGE (toutes
-- les lignes existantes la respectent) ; table de journal de petite taille.
-- Retour arrière : les colonnes peuvent rester (ignorées par l'ancien code) ;
-- l'ancienne contrainte ne peut être remise qu'après suppression des lignes
-- `gate:` (DELETE FROM property_recovery_runs WHERE batch_fp LIKE 'gate:%').
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE property_recovery_runs ADD COLUMN IF NOT EXISTS cause TEXT;
ALTER TABLE property_recovery_runs ADD COLUMN IF NOT EXISTS contract_state TEXT;
ALTER TABLE property_recovery_runs ADD COLUMN IF NOT EXISTS campaign_id BIGINT;

ALTER TABLE property_recovery_runs DROP CONSTRAINT IF EXISTS property_recovery_runs_status_chk;
ALTER TABLE property_recovery_runs ADD CONSTRAINT property_recovery_runs_status_chk CHECK (status IN (
  'ANSWERED', 'NO_EVIDENCE', 'AI_FAILED', 'BUDGET_EXHAUSTED',
  'CONTRACT_PENDING', 'RETRY_SCHEDULED', 'DRY_RUN', 'REPAIR_SUPPRESSED', 'NOT_SELECTED', 'NOT_EXECUTED', 'MEMORY_UNAVAILABLE'
)) NOT VALID;
ALTER TABLE property_recovery_runs VALIDATE CONSTRAINT property_recovery_runs_status_chk;

COMMENT ON COLUMN property_recovery_runs.cause IS
  'Lot 91B : cause explicite de l''issue (contrat T3 absent, budget, panne, nouvelle tentative, campagne à blanc, objet non sélectionné…).';
COMMENT ON COLUMN property_recovery_runs.contract_state IS
  'Lot 91B : état du contrat T3 (t3-knowledge-query-v2) au moment de l''issue : CARRIED, MARKER_MISSING, BRANCH_MISSING, DISABLED, UNREADABLE.';
COMMENT ON COLUMN property_recovery_runs.campaign_id IS
  'Lot 91B : campagne de cohérence (coherence_campaigns.id) de l''issue ; NULL pour un contrôle ciblé ou un rattrapage hors campagne.';
