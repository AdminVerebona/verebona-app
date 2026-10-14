-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0349 : exclusion MÉMORISÉE d'un bien retiré d'un sinistre (lot 53C
-- — retour PO Q17 : « ne jamais réintégrer le bien automatiquement contre la
-- décision utilisateur ; mémoriser l'exclusion jusqu'à un nouvel arbitrage »).
--
--   business_operation_asset_exclusions
--       UNE ligne active par (Opération, bien) que l'utilisateur a retiré de
--       la saisie Sinistre. La consolidation T3 ne relie plus ce bien à
--       l'Opération, même si un document le cite ; un NOUVEAU document qui le
--       cite produit une carte « À traiter » de décision (document à
--       l'origine), jamais une réintégration. `acknowledged_file_ids` : les
--       documents déjà arbitrés (« il reste hors du sinistre ») — pas de
--       nouvelle carte pour eux. Réintégration (formulaire, ou choix de la
--       carte) : ligne désactivée (`released_at`, `release_reason`), jamais
--       supprimée (audit).
--
-- Table neuve, vide : aucun verrou long. Non déclarée dans Drizzle (même choix
-- que 0337 / 0338) : le code tolère son absence (comportement antérieur).
-- Index d'unicité partiel posé CONCURRENTLY dans 0349_…_idx_1. Idempotente.
-- Retour arrière : DROP TABLE IF EXISTS business_operation_asset_exclusions
-- (le code redevient celui du lot 52 : pas de mémoire d'exclusion).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS business_operation_asset_exclusions (
  id                     BIGSERIAL    PRIMARY KEY,
  account_id             INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operation_id           BIGINT       NOT NULL REFERENCES business_operations(id) ON DELETE CASCADE,
  asset_id               INTEGER      NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  active                 BOOLEAN      NOT NULL DEFAULT true,
  reason_code            TEXT         NOT NULL DEFAULT 'CLAIM_FORM_ASSET_EXCLUDED',
  excluded_by_user_id    INTEGER,
  acknowledged_file_ids  INTEGER[]    NOT NULL DEFAULT '{}',
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  released_at            TIMESTAMPTZ,
  release_reason         TEXT
);
