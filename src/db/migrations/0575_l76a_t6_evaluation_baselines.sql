-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0575 : références de transition des signatures EVALUATE (lot 76A —
-- ticket « [P1] T6 — Compléter l’invalidation EVALUATE et empêcher les
-- suggestions contradictoires », AC04).
--
-- Le lot 76A complète la signature de configuration EVALUATE (`e2:`) : chaîne
-- ORDONNÉE des modèles (principal puis replis), niveau de raisonnement de
-- chaque rang, limite de sortie — valeurs résolues comme par la passerelle.
-- Les décisions déjà enregistrées portent la signature du lot 72A (`e1:` :
-- prompt EVALUATE, contrats, modèle principal, seuil).
--
--   t6_evaluation_signature_baselines
--     legacy_signature  signature `e1:` (calcul du lot 72A)
--     signature         signature complète `e2:` observée la PREMIÈRE fois
--                       avec cette signature `e1:` (écrite par le code au
--                       premier passage T6 après déploiement ; la première
--                       l'emporte, jamais réécrite)
--     observed_at       date de cette première observation
--
-- Transition SANS invalidation de masse : une décision `e1:` égale au calcul
-- `e1:` courant reste valable tant que la signature complète courante est
-- celle de référence ; dès qu'un repli, son ordre, un niveau de raisonnement
-- ou la limite de sortie change, elle est invalidée et réévaluée. Table
-- absente (fenêtre de déploiement) : aucune invalidation (comportement 72A).
-- Aucune donnée personnelle. Idempotente, rejouable.
-- Retour arrière : table ignorée par le code du lot 75 (DROP TABLE IF EXISTS possible).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS t6_evaluation_signature_baselines (
  legacy_signature TEXT PRIMARY KEY,
  signature        TEXT NOT NULL,
  observed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE t6_evaluation_signature_baselines IS
  'Lot 76A : signature EVALUATE complète (e2) de référence pour chaque signature du lot 72A (e1) — transition sans invalidation de masse.';
