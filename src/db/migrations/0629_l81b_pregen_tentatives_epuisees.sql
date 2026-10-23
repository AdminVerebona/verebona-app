-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0629 : épuisement EXPLICITE des demandes de pré-génération de la
-- mascotte (lot 81B — ticket « [P1] T6 — Corriger les écarts résiduels du lot
-- 78C », écart C).
--
-- Une demande (`home_mascot_pregen_requests`) n'est plus prise au-delà de
-- trois prises sans aboutir (`attempts`). Jusqu'ici elle devenait alors
-- simplement non sélectionnable, sans état terminal : des évaluations T6
-- pouvaient rester PENDING sans que rien ne les reprenne ni ne le signale.
--
--   exhausted_count  épuisements successifs sans progrès (remis à zéro par
--                    tout nouveau signal du compte ou une reprise BO) ;
--                    au plus 3 reprises automatiques, puis reprise explicite
--   exhausted_at     dernier épuisement constaté
--
-- L'état lui-même est porté par `last_status = 'attempts_exhausted'` (texte
-- libre existant) ; la supervision (BO › Supervision) le signale tant que des
-- évaluations du compte restent incomplètes.
--
-- Colonnes ajoutées avec une valeur par défaut constante (aucune réécriture
-- de la table, une ligne par compte). Le code sonde leur présence : absentes
-- (fenêtre de déploiement), le comportement du lot 78C est conservé.
-- Idempotente, rejouable. Retour arrière : colonnes ignorées par l'ancien
-- code (ALTER TABLE … DROP COLUMN IF EXISTS possible).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('home_mascot_pregen_requests') IS NOT NULL THEN
    ALTER TABLE home_mascot_pregen_requests ADD COLUMN IF NOT EXISTS exhausted_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE home_mascot_pregen_requests ADD COLUMN IF NOT EXISTS exhausted_at TIMESTAMPTZ;
    COMMENT ON COLUMN home_mascot_pregen_requests.exhausted_count IS
      'Lot 81B : épuisements successifs des tentatives de la demande sans progrès (reprise automatique bornée, puis BO).';
    COMMENT ON COLUMN home_mascot_pregen_requests.exhausted_at IS
      'Lot 81B : dernier épuisement des tentatives de la demande (last_status = attempts_exhausted).';
  END IF;
END $$;
