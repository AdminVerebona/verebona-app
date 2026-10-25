-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0756 : questions suggérées T6 FONDÉES — version de contrat, trace
-- de génération et invalidations (lot 87C, ticket P1 « T6 — fiabiliser la
-- pertinence, le fondement et la répondabilité des questions suggérées »).
--
--   home_mascot_cache.suggestion_contract (TEXT, NULL)
--       Contrat des questions conservées (`t6-suggestions-v3`). Une entrée
--       d'un autre contrat (ou NULL : entrée antérieure) n'est JAMAIS servie
--       avec des questions : la clé de cache intègre déjà la version du
--       contrat et l'empreinte des fondements, la colonne en fait une
--       garantie vérifiable à la lecture et par le contrôle de cohérence.
--   home_mascot_cache.trace_id (TEXT, NULL)
--       Trace de la génération T6 qui a produit l'entrée : relie une
--       invalidation postérieure (lecture du cache, contrôle de cohérence) à
--       la ligne de `home_mascot_generations` correspondante.
--   home_mascot_generations.suggestion_report (JSONB, NULL)
--       Trace des questions de la génération (références seulement, jamais de
--       texte de document) : contrat, prompt compatible ou non, nombre de
--       questions produites / acceptées / rejetées, motifs structurés des
--       rejets, fondements (références et clés stables) des questions
--       acceptées, invalidations postérieures (date, origine, motif).
--
-- Colonnes nullables sans défaut : ajout instantané, aucune réécriture.
-- Colonnes non déclarées dans Drizzle (tables lues et écrites en SQL par
-- `home/mascot/t6-runner.ts` et `t6-suggestion-grounds.ts`). Idempotente.
-- Retour arrière : ALTER TABLE home_mascot_cache DROP COLUMN IF EXISTS
--   suggestion_contract, DROP COLUMN IF EXISTS trace_id ; ALTER TABLE
--   home_mascot_generations DROP COLUMN IF EXISTS suggestion_report (code
--   tolérant : sans ces colonnes, aucune question n'est servie depuis le
--   cache et la trace n'est pas écrite).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE home_mascot_cache ADD COLUMN IF NOT EXISTS suggestion_contract TEXT;
ALTER TABLE home_mascot_cache ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE home_mascot_generations ADD COLUMN IF NOT EXISTS suggestion_report JSONB;
