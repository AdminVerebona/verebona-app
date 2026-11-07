-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1540 : provenance de la question d'une carte « À traiter » (lot
-- 113S, Trello #716 « À traiter — Faire formuler les arbitrages métier par
-- T3/T4, sans questions génériques imposées par le code »).
--
-- to_process_actions.question_source — d'où vient la question affichée :
--   · origin = 'AI'   : question formulée par le traitement IA (T3, T4) dans sa
--                       sortie structurée, contrôlée par le serveur
--                       (`to-process/ai-user-question.ts`), affichée sans
--                       réécriture ;
--   · origin = 'CODE' : formulation déterministe du producteur (repli), avec le
--                       motif (question absente, refusée, IA non appelée).
-- Plus : règle, traitement, opération IA, marqueur du contrat et présence dans
-- la version effective du prompt, version de prompt, trace, date. Jamais le
-- texte d'un document ni une valeur d'identifiant.
--
-- Additive (colonne nullable sans défaut : NULL = carte antérieure au lot
-- 113S, question du producteur), idempotente, rejouable. L'ancien code
-- l'ignore. Aucune donnée réécrite ici : les cartes ouvertes sont requalifiées
-- par leur producteur au passage suivant (même carte, aucune réouverture,
-- événement QUESTION_UPDATED).
-- Retour arrière : ALTER TABLE to_process_actions DROP COLUMN question_source.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE to_process_actions ADD COLUMN IF NOT EXISTS question_source JSONB;
