-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0578 : T3 — harmonisation documentaire, défauts résiduels du lot
-- 72B (lot 76B, ticket « [P1] T3 — Corriger les défauts résiduels de reprise,
-- de réévaluation et de finalisation du lot 72B », C1 à C5).
--
--   document_rename_events (C1, C2)
--       outcome + DECIDED : décision validée par les garde-fous, PERSISTÉE
--       AVANT son application (même transaction que la progression de
--       l'examen), `retry_status = 'PENDING'`. L'écriture réussie la retire
--       dans sa propre transaction (renommage + historique APPLIED) ; un échec
--       la convertit en FAILED / PENDING (reprise sans nouvel appel IA). Les
--       écritures restantes se lisent en base, tous passages confondus :
--       jamais de lot ni de compte terminé avec une décision non appliquée.
--       Contrainte élargie NOT VALID (les lignes existantes respectent déjà
--       l'ancienne, plus stricte) : aucun parcours de la table.
--
--   document_naming_groups (C5)
--       status + UPGRADE_REVIEW : lot examiné avec un contexte antérieur
--       (lot 61 / 72B) dont l'absence d'information nouvellement exploitable
--       n'est PAS démontrée — réexamen BORNÉ et reprenable programmé ;
--       upgrade_state : TECHNICAL (recalage sans appel, preuve faite),
--       EXPECTED (réexamen attendu), REVIEWED (réexamen effectué) ;
--       upgrade_from, upgrade_reason, upgrade_at : traçabilité (BO).
--
--   (C4 : aucune colonne ni déclencheur ajouté sur document_facts — la
--   réactivation réutilise le journal de connaissance existant
--   `account_knowledge_changes`, lot 34E, qui couvre création, modification,
--   désactivation et suppression des faits.)
--
-- Idempotente, rejouable. Aucun index CONCURRENTLY.
-- Retour arrière : le code du lot 75 ignore les colonnes ; il ne lit pas les
-- lignes DECIDED (outcome inconnu de ses requêtes) ni le statut
-- UPGRADE_REVIEW (lot traité comme à réexaminer).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE document_rename_events DROP CONSTRAINT IF EXISTS document_rename_events_outcome_check;
ALTER TABLE document_rename_events ADD CONSTRAINT document_rename_events_outcome_check
  CHECK (outcome IN ('APPLIED', 'REFUSED', 'CONFLICT', 'NO_CHANGE', 'FAILED', 'DECIDED')) NOT VALID;

ALTER TABLE document_naming_groups DROP CONSTRAINT IF EXISTS document_naming_groups_status_check;
ALTER TABLE document_naming_groups ADD CONSTRAINT document_naming_groups_status_check
  CHECK (status IN ('DONE', 'IN_PROGRESS', 'DEFERRED', 'ERROR', 'PROMPT_UNAVAILABLE', 'WRITE_PENDING', 'UPGRADE_REVIEW'));

ALTER TABLE document_naming_groups ADD COLUMN IF NOT EXISTS upgrade_state  TEXT;
ALTER TABLE document_naming_groups ADD COLUMN IF NOT EXISTS upgrade_from   TEXT;
ALTER TABLE document_naming_groups ADD COLUMN IF NOT EXISTS upgrade_reason TEXT;
ALTER TABLE document_naming_groups ADD COLUMN IF NOT EXISTS upgrade_at     TIMESTAMPTZ;

ALTER TABLE document_naming_groups DROP CONSTRAINT IF EXISTS document_naming_groups_upgrade_state_check;
ALTER TABLE document_naming_groups ADD CONSTRAINT document_naming_groups_upgrade_state_check
  CHECK (upgrade_state IS NULL OR upgrade_state IN ('TECHNICAL', 'EXPECTED', 'REVIEWED'));
