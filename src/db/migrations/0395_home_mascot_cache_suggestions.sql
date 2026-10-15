-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0395 : questions suggérées de l'accueil dans le cache T6 (lot 55A —
-- « T6 / T2 — Cohérence des suggestions IA »).
--
--   home_mascot_cache.suggestions (JSONB, NULL)
--       Questions « Ou demandez-moi » rédigées par T6 DANS LA MÊME génération
--       que les textes de la bulle (règle R12 du prompt maître). La clé de
--       cache inclut alors le contexte des questions : bulle et questions sont
--       servies ensemble, jamais des questions d'un autre état du compte.
--       NULL : génération sans questions (ancienne entrée, version du prompt
--       sans {{SUGGESTION_CONTEXT}}) — l'accueil n'affiche alors aucune question.
--
-- Colonne nullable, sans valeur par défaut : ajout instantané, aucune
-- réécriture. Idempotente. Pas d'index (lecture par clé primaire).
-- Retour arrière : ALTER TABLE home_mascot_cache DROP COLUMN IF EXISTS suggestions;
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE home_mascot_cache ADD COLUMN IF NOT EXISTS suggestions JSONB;
