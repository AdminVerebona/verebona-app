-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0136 : charge utile des travaux de file — CDC BO IA GEN-004.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- POURQUOI UNE COLONNE PLUTÔT QUE DES CHAMPS DÉDIÉS
--
-- Un travail d'analyse porte deux informations que la table ne prévoyait pas :
-- l'utilisateur à l'origine du dépôt et l'appelant qui l'a demandé. Elles
-- servent à la reprise — le pipeline attribue l'analyse à un utilisateur, et
-- l'origine est journalisée pour suivre une bascule.
--
-- Les loger dans `trigger_code` aurait marché une fois, puis obligé à les
-- concaténer, puis à les analyser. Chaque traitement a ses propres besoins :
-- une colonne libre, bornée à ce que le traitement sait relire, vieillit mieux
-- que trois colonnes dont deux sont toujours nulles.
--
-- ⚠️ Ce n'est PAS un fourre-tout. Le §26.2 interdit de sérialiser un compte
-- entier : cette colonne porte des identifiants et des libellés, jamais des
-- données métier. Le travail retrouve ses données en base au moment de
-- s'exécuter — c'est ce qui garantit qu'il traite l'état courant et non celui
-- du jour où il a été mis en file.
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE ai_job_queue
  ADD COLUMN IF NOT EXISTS payload JSONB;

COMMENT ON COLUMN ai_job_queue.payload IS
  'Contexte de reprise du travail : identifiants et libellés uniquement. '
  'Jamais de données métier — elles sont relues en base à l''exécution.';
