-- ─────────────────────────────────────────────────────────────────────────
-- Migration 1940 : IA — borne COMMUNE à toutes les instances des appels émis
-- sans protection anti-redondance (lot 117, carte Trello #828, écart A ;
-- suite de la carte #811).
--
-- La borne de la carte #811 (`AI_DEGRADED_CALLS_PER_HOUR`) était tenue en
-- mémoire par chaque processus : N instances admettaient N fois le budget.
-- Cette table porte le compteur partagé, par heure d'horloge et par portée
-- (traitement, opération, compte ; 0 = sans compte) :
--   · admitted  appels admis en mode dégradé pendant l'heure (toutes
--               instances) — incrémenté de façon atomique, jamais au-delà du
--               budget ;
--   · refused   appels refusés avant tout contact du fournisseur.
-- Elle sert aussi de trace du VOLUME réel des appels émis sans protection.
--
-- Table NEUVE : additive, idempotente, rejouable, aucune reprise de données.
-- Pas de clé étrangère vers `accounts` : l'écriture doit rester possible pour
-- un appel sans compte et ne jamais attendre un verrou d'une autre table.
-- Absente : l'application retombe sur la borne par instance et le diagnostic
-- du BO le dit (constat MIGRATION_1940).
-- Retour arrière : DROP TABLE IF EXISTS ai_degraded_call_budget.
-- ─────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_degraded_call_budget (
  hour_start     TIMESTAMPTZ NOT NULL,
  treatment      TEXT        NOT NULL DEFAULT '',
  operation_code TEXT        NOT NULL DEFAULT '',
  account_id     INTEGER     NOT NULL DEFAULT 0,
  admitted       INTEGER     NOT NULL DEFAULT 0,
  refused        INTEGER     NOT NULL DEFAULT 0,
  first_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_degraded_call_budget_pk PRIMARY KEY (hour_start, treatment, operation_code, account_id),
  CONSTRAINT ai_degraded_call_budget_counts_chk CHECK (admitted >= 0 AND refused >= 0)
);
