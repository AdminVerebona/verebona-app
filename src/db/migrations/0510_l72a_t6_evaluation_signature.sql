-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0510 : signature de configuration des décisions EVALUATE (lot 72A —
-- ticket « [P1] T6 — Corriger les écarts résiduels du contrat EVALUATE et
-- fiabiliser la bulle d'accueil », AC02).
--
--   t6_interpellation_assessments
--     evaluation_signature  signature déterministe de ce qui a DÉTERMINÉ la
--                           décision : section EVALUATE du prompt maître
--                           effectif (version BO, sinon texte livré), contrats
--                           d'entrée et de sortie, modèle principal, seuil
--                           indicatif. Une décision prise sous une autre
--                           signature est INVALIDÉE (jamais réutilisée) et
--                           réévaluée ; une révision de la seule branche
--                           FORMULATE ne change rien.
--
-- Colonne NULLable, sans réécriture : les décisions existantes (NULL) sont
-- comparées par la version du master déjà conservée (`prompt_version`) — aucune
-- réévaluation de masse au déploiement. Le code la lit par `to_jsonb(...)` et
-- sonde sa présence avant d'écrire : la fenêtre de déploiement est sans effet.
-- Idempotente, rejouable.
-- Retour arrière : colonne ignorée par le code du lot 71
-- (ALTER TABLE … DROP COLUMN IF EXISTS evaluation_signature possible).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('t6_interpellation_assessments') IS NOT NULL THEN
    ALTER TABLE t6_interpellation_assessments
      ADD COLUMN IF NOT EXISTS evaluation_signature TEXT;

    COMMENT ON COLUMN t6_interpellation_assessments.evaluation_signature IS
      'Lot 72A : signature de la configuration EVALUATE (section EVALUATE du prompt effectif, contrats, modèle, seuil). Différente de la courante : décision invalidée.';
  END IF;
END $$;
