-- Migration 0128 — Socle V2 : Rubriques, « Bien mis en location », file « À traiter »
--
-- ═════════════════════════════════════════════════════════════════════════════
-- ADDITIVE, ET DÉLIBÉRÉMENT
--
-- Le CDC V2 §13.1 décrit un modèle documentaire qui remplace celui de la V1 :
-- `rubric_code` au lieu de `document_category_id`, état de classement dérivé
-- au lieu de `classification_state`.
--
-- Cette migration n'enlève pourtant rien. Le §15 impose que le basculement
-- passe par un retraitement complet du parc via le moteur d'optimisation
-- existant — un traitement asynchrone, qui dure, et dont on ne connaît le
-- résultat qu'après. Supprimer les colonnes V1 maintenant rendrait ce
-- retraitement irréversible : un défaut découvert à mi-parcours laisserait
-- les documents sans classement d'aucune sorte.
--
-- Les colonnes V1 restent donc en place et servent l'affichage jusqu'à ce que
-- le retraitement soit vérifié. Leur suppression fait l'objet du lot 4.
--
-- Idempotente. Aucune donnée existante n'est modifiée.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 1. Classement V2 sur les documents (§13.1) ──────────────────────────────

ALTER TABLE asset_files
  ADD COLUMN IF NOT EXISTS rubric_code                          TEXT,
  ADD COLUMN IF NOT EXISTS document_type_code                   TEXT,
  ADD COLUMN IF NOT EXISTS rubric_origin                        TEXT,
  ADD COLUMN IF NOT EXISTS type_origin                          TEXT,
  ADD COLUMN IF NOT EXISTS rubric_user_validated                BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS type_user_validated                  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS rubric_confidence                    NUMERIC,
  ADD COLUMN IF NOT EXISTS type_confidence_v2                   NUMERIC,
  ADD COLUMN IF NOT EXISTS classification_referential_version   TEXT;

COMMENT ON COLUMN asset_files.rubric_code IS
  'Rubrique V2. NULL = « Sans rubrique » (§13.1). L''état classé/à classer '
  'est dérivé de cette colonne et n''est plus stocké séparément.';

COMMENT ON COLUMN asset_files.classification_referential_version IS
  'Version du référentiel ayant produit la décision. Une valeur différente de '
  'la version courante identifie les documents à retraiter (§11.6).';

CREATE INDEX IF NOT EXISTS asset_files_rubric_code_idx
  ON asset_files (account_id, rubric_code);

-- ── 2. Attribut « Bien mis en location » (§6.1) ─────────────────────────────
--
-- Le défaut FALSE est une valeur système, pas une réponse de l'utilisateur.
-- `is_rented_user_validated` porte la différence : sans elle, tous les biens
-- seraient protégés dès la migration et l'IA ne pourrait plus jamais
-- renseigner l'attribut — l'inverse exact de l'intention du §6.1.

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS is_rented                 BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_rented_origin          TEXT NOT NULL DEFAULT 'SYSTEM_RULE',
  ADD COLUMN IF NOT EXISTS is_rented_user_validated  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_rented_updated_at      TIMESTAMPTZ;

COMMENT ON COLUMN assets.is_rented_user_validated IS
  'FALSE tant que l''utilisateur n''a pas répondu explicitement. Le défaut '
  '« Non » de is_rented ne vaut pas validation (§6.1).';

-- ── 3. File d'actions « À traiter » (§13.3) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS to_process_actions (
  id                  SERIAL PRIMARY KEY,
  public_id           UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  account_id          INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  target_type         TEXT NOT NULL,
  target_id           INTEGER NOT NULL,

  field_key           TEXT,
  relation_key        TEXT,

  action_kind         TEXT NOT NULL,
  rule_code           TEXT NOT NULL,
  priority            TEXT NOT NULL DEFAULT 'DO_NEXT',

  question            TEXT NOT NULL,
  proposals_json      JSONB,
  due_date            TIMESTAMPTZ,

  active_since        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ,
  resolution_reason   TEXT,

  cycle_number        INTEGER NOT NULL DEFAULT 1,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT to_process_actions_kind_check
    CHECK (action_kind IN ('ARBITRATE', 'COMPLETE')),
  CONSTRAINT to_process_actions_priority_check
    CHECK (priority IN ('DO_FIRST', 'DO_NEXT', 'CAN_WAIT')),
  -- Exactement l'une des deux clés. Les deux renseignées rendraient la clé
  -- d'unicité du §7.3 ambiguë ; aucune la rendrait inopérante.
  CONSTRAINT to_process_actions_key_check
    CHECK ((field_key IS NULL) <> (relation_key IS NULL))
);

CREATE INDEX IF NOT EXISTS to_process_actions_account_idx
  ON to_process_actions (account_id);

CREATE INDEX IF NOT EXISTS to_process_actions_active_idx
  ON to_process_actions (account_id, resolved_at, priority);

CREATE INDEX IF NOT EXISTS to_process_actions_target_idx
  ON to_process_actions (target_type, target_id);

CREATE INDEX IF NOT EXISTS to_process_actions_public_id_idx
  ON to_process_actions (public_id);

-- ── 4. Unicité logique d'une action ACTIVE (§13.4) ──────────────────────────
--
-- « Une contrainte d'unicité logique doit garantir une seule action active
--   pour la combinaison account + target + field/relation + action_kind. Les
--   actions résolues restent historisées et ne bloquent pas la création d'un
--   cycle ultérieur. »
--
-- D'où l'index PARTIEL : sans la clause WHERE, la ligne résolue occuperait la
-- place et le §7.3 — « si un problème résolu réapparaît, une nouvelle action
-- est créée » — deviendrait impossible à honorer.
--
-- COALESCE fond field_key et relation_key : deux NULL ne sont jamais égaux en
-- SQL, et un index posé sur les deux colonnes laisserait passer les doublons
-- qu'il est censé interdire.

CREATE UNIQUE INDEX IF NOT EXISTS to_process_actions_active_unique_idx
  ON to_process_actions (
    account_id,
    target_type,
    target_id,
    COALESCE(field_key, relation_key),
    action_kind
  )
  WHERE resolved_at IS NULL;

COMMENT ON TABLE to_process_actions IS
  'File unique d''actions utilisateur (CDC V2 §7). Une ligne = une action, '
  'pas un objet. Les lignes résolues sont conservées : elles empêchent la '
  'recréation d''une action « Non applicable » (§7.4).';
