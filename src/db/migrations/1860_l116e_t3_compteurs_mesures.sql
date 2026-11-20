-- ─────────────────────────────────────────────────────────────────────────
-- Migration 1860 : T3 — compteurs d'appels MESURÉS (lot 116, carte Trello
-- #811, écart P1-A du ticket #596).
--
-- `account_reconciliation_runs.provider_calls` (0858) additionnait des
-- valeurs de sémantiques différentes : revues demandées par le moteur des
-- biens, cartes « À traiter » marquées `aiCalled`, appels de nommage comptés
-- AVANT l'envoi. Ce n'était pas un nombre d'appels réels.
--
-- À partir de cette migration, pour tout passage écrit par le nouveau code :
--   · `provider_calls`                  = requêtes RÉELLEMENT émises vers le
--     fournisseur pendant le passage (mesure de la passerelle, toutes phases
--     et sous-phases, autres traitements déclenchés en ligne compris) ;
--   · `provider_calls_other_treatments` = dont requêtes d'un autre traitement
--     que T3 (T4 déclenché pendant T3…) ;
--   · `provider_attempts`               = tentatives de modèle et passes de
--     réparation ayant émis au moins une requête ;
--   · `ai_logical_requests`             = demandes logiques à la passerelle ;
--   · `ai_requests_declared`            = ancienne somme des demandes
--     déclarées par les phases (sémantique d'avant, conservée sous son nom) ;
--   · `ai_counters_semantics`           = `MEASURED_V1` (mesure) ou `DECLARED`
--     (passerelle non observée : demandes déclarées, étiquetées) ;
--   · `ai_activity`                     = relevé complet (par traitement,
--     opération, phase, modèle et rang ; coût observé / estimé / inconnu ;
--     identifiants de trace pour le rapprochement avec `ai_usage_event`).
--
-- HISTORIQUE : aucune ligne existante n'est modifiée ni recalculée.
-- `ai_counters_semantics IS NULL` = « ancienne sémantique » (valeur d'origine
-- de `provider_calls`, non prouvable a posteriori).
--
-- IDEMPOTENTE et NON DESTRUCTIVE : `ADD COLUMN IF NOT EXISTS` de colonnes
-- NULLABLES sans valeur par défaut (aucune réécriture de table), aucune
-- colonne retirée, rejouable sans effet.
-- Retour arrière : les colonnes peuvent rester (l'ancien code les ignore).
-- ─────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE account_reconciliation_runs ADD COLUMN IF NOT EXISTS ai_counters_semantics           TEXT;
ALTER TABLE account_reconciliation_runs ADD COLUMN IF NOT EXISTS ai_requests_declared            INTEGER;
ALTER TABLE account_reconciliation_runs ADD COLUMN IF NOT EXISTS ai_logical_requests             INTEGER;
ALTER TABLE account_reconciliation_runs ADD COLUMN IF NOT EXISTS provider_attempts               INTEGER;
ALTER TABLE account_reconciliation_runs ADD COLUMN IF NOT EXISTS provider_calls_other_treatments INTEGER;
ALTER TABLE account_reconciliation_runs ADD COLUMN IF NOT EXISTS ai_activity                     JSONB;

ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS ai_counters_semantics TEXT;
ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS ai_requests_declared  INTEGER;
ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS ai_activity           JSONB;
