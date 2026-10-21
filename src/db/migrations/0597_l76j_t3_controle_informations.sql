-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0597 : T3 — contrôle exhaustif de complétude et de cohérence de
-- l'onglet « Informations » (lot 76J — ticket « [P1] T3 — Généraliser le
-- contrôle de complétude et de cohérence des données de l'onglet
-- Informations »).
--
--   t3_information_checks — une ligne par bien : VERSION du contrôle
--     exhaustif déjà appliquée au bien (`check_version`), date et run local
--     du dernier contrôle, synthèse chiffrée (champs examinés, non
--     applicables, complétés, corrigés, contradictions, arbitrages, non
--     vérifiables) et mémoire des arbitrages croisés déjà proposés
--     (`cross_signatures` : un arbitrage tranché par l'utilisateur n'est
--     jamais reproposé sans élément nouveau).
--
--     Sert le RATTRAPAGE AUTOMATIQUE du stock : un bien sans ligne (ou d'une
--     version antérieure) est repris par le passage T3 planifié du compte,
--     au plus `T3_INFORMATION_BACKFILL_MAX_ASSETS` biens par passage
--     (reprenable : la ligne n'est écrite qu'après un contrôle complet).
--
-- Table neuve : aucune réécriture, aucun verrou long. Le code sonde sa
-- présence (absente : contrôle exécuté, rattrapage et mémoire désactivés).
-- Index dans 0597_..._idx_1 (CONCURRENTLY). Idempotente.
-- Retour arrière : DROP TABLE IF EXISTS t3_information_checks (le contrôle
-- reste exécuté sur les biens touchés ; plus de rattrapage du stock).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS t3_information_checks (
  asset_id         INTEGER     PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  account_id       INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  check_version    TEXT        NOT NULL,
  checked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_id      INTEGER,
  summary          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  cross_signatures JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT t3_information_checks_summary_chk CHECK (jsonb_typeof(summary) = 'object'),
  CONSTRAINT t3_information_checks_signatures_chk CHECK (jsonb_typeof(cross_signatures) = 'object')
);

COMMENT ON TABLE t3_information_checks IS
  'Lot 76J : contrôle exhaustif T3 de l''onglet Informations — version appliquée par bien (rattrapage automatique borné), synthèse, arbitrages croisés déjà proposés.';
