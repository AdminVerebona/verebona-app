-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0696 : Opérations v5, lot O-6 — reconsolidation CIBLÉE (lot 84E ;
-- CDC « Opérations, Agenda, Timeline, Sinistres v5 » §9.3, §9.4, §27.6 ;
-- arbitrages PO V-Q5, C-Q2, C-Q10, C-Q11).
--
-- Les fonctions de reconsolidation ciblée (`consolidation/targeted.ts` :
-- pour un équipement, un bien, une Pièce, une série de documents récurrents ;
-- liens directs Document ↔ Équipement des documents d'une Opération) sont
-- JOURNALISÉES (§27.6) : une ligne par exécution — déclencheur, cible,
-- corrélation (celle des écritures de l'historique des Opérations et des
-- liens documentaires), compteurs, appels IA, issue. Le retour arrière d'une
-- exécution suit les journaux du domaine qu'elle référence (historique des
-- Opérations par corrélation, liens documentaires d'origine AI) ; cette table
-- n'est qu'une TRACE (aucune donnée métier).
--
-- Additive, idempotente, aucune reprise de données. Conservée telle quelle
-- lors d'une restauration (RESTORE_KEEP_CURRENT_TABLES), comme les autres
-- journaux d'exécution. Index : 0696_..._idx_1 (CONCURRENTLY).
-- Retour arrière : DROP TABLE IF EXISTS business_operation_targeted_runs.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS business_operation_targeted_runs (
  id               BIGSERIAL   PRIMARY KEY,
  account_id       INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind             TEXT        NOT NULL,
  target_id        BIGINT,
  trigger          TEXT        NOT NULL,
  correlation_id   TEXT,
  status           TEXT        NOT NULL,
  skipped_reason   TEXT,
  dry_run          BOOLEAN     NOT NULL DEFAULT false,
  counts           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  operation_ids    BIGINT[]    NOT NULL DEFAULT '{}',
  ai_calls         INTEGER     NOT NULL DEFAULT 0,
  error            TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  CONSTRAINT business_operation_targeted_runs_kind_chk CHECK (kind IN ('EQUIPMENT', 'ASSET', 'ROOM', 'RECURRING_DOCUMENTS', 'DIRECT_LINKS')),
  CONSTRAINT business_operation_targeted_runs_status_chk CHECK (status IN ('DONE', 'SKIPPED', 'FAILED')),
  CONSTRAINT business_operation_targeted_runs_counts_chk CHECK (jsonb_typeof(counts) = 'object'),
  CONSTRAINT business_operation_targeted_runs_ai_chk CHECK (ai_calls >= 0)
);

COMMENT ON TABLE business_operation_targeted_runs IS
  'Lot 84E (CDC v5 O-6, §27.6) : journal des reconsolidations ciblées (équipement, bien, Pièce, série de documents récurrents, liens directs Document ↔ Équipement) — trace, aucune donnée métier.';
