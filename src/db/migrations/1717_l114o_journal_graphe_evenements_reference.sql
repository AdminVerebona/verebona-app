-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1717 : graphe canonique des événements de référence — JOURNAL des
-- commandes d'écriture (lot 114O, carte Trello #744, CDC « Opérations / Agenda
-- V2.0 » §4 « historique », §19, §20 « clé d'idempotence », lot B).
--
-- `business_operation_graph_history` (nouvelle) : UNE ligne par changement
-- appliqué par la façade métier `operation-write.facade.ts` : relation du
-- graphe (relation entre Opérations, lien Opération ↔ élément d'Agenda, lien
-- Opération ↔ document, lien Opération ↔ fournisseur) ou Opération elle-même
-- (création sur déclaration, correction, invalidation, restauration par
-- l'utilisateur) : objet, action, origine, auteur, canal, motif,
-- preuves, état avant / après, corrélation, et — pour le REJEU — la commande,
-- sa clé d'idempotence, l'empreinte de son entrée (`input_hash`) et le résultat
-- rendu. Une commande rejouée avec la même clé ET la même entrée rend le
-- résultat enregistré sans rien réécrire ; même clé, autre entrée : conflit.
--
-- Journal en AJOUT seul (jamais modifié). Les identifiants d'Opération,
-- d'élément et de document n'y sont PAS des clés étrangères : la trace survit
-- au retrait de l'objet (seule la suppression du compte l'efface, exigence
-- d'effacement définitif). Les écritures de la colonne historique restent
-- tracées par `business_operation_history` (service de regroupement).
--
-- Additive, idempotente, rejouable ; aucune reprise de données. Retour
-- arrière : DROP TABLE business_operation_graph_history.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS business_operation_graph_history (
  id                    BIGSERIAL    PRIMARY KEY,
  account_id            INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  relation_kind         TEXT         NOT NULL,
  operation_id          BIGINT       NOT NULL,
  other_operation_id    BIGINT,
  agenda_item_id        INTEGER,
  file_id               INTEGER,
  supplier_id           INTEGER,
  action                TEXT         NOT NULL,
  origin                TEXT         NOT NULL,
  channel               TEXT,
  actor_user_id         INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  reason_code           TEXT         NOT NULL,
  evidence              JSONB        NOT NULL DEFAULT '[]'::jsonb,
  before_json           JSONB,
  after_json            JSONB,
  command               TEXT,
  idempotency_key       TEXT,
  input_hash            TEXT,
  result_json           JSONB,
  correlation_id        TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_graph_history_kind_chk') THEN
    ALTER TABLE business_operation_graph_history ADD CONSTRAINT business_operation_graph_history_kind_chk
      CHECK (relation_kind IN ('OPERATION_RELATION', 'AGENDA_LINK', 'DOCUMENT_LINK', 'SUPPLIER_LINK', 'OPERATION'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_graph_history_action_chk') THEN
    ALTER TABLE business_operation_graph_history ADD CONSTRAINT business_operation_graph_history_action_chk
      CHECK (action IN ('CREATED', 'REACTIVATED', 'UPDATED', 'REMOVED', 'REJECTED', 'MOVED', 'REASSIGNED_ON_MERGE', 'ACCOUNT_TRANSFER', 'NO_CHANGE', 'INVALIDATED', 'RESTORED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_graph_history_origin_chk') THEN
    ALTER TABLE business_operation_graph_history ADD CONSTRAINT business_operation_graph_history_origin_chk
      CHECK (origin IN ('USER', 'AI', 'MIGRATION', 'SYSTEM'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_graph_history_evidence_chk') THEN
    ALTER TABLE business_operation_graph_history ADD CONSTRAINT business_operation_graph_history_evidence_chk
      CHECK (jsonb_typeof(evidence) = 'array');
  END IF;
END $$;

-- Historique d'une Opération (les deux extrémités d'une relation).
CREATE INDEX IF NOT EXISTS business_operation_graph_history_operation_idx
  ON business_operation_graph_history (account_id, operation_id, id);
CREATE INDEX IF NOT EXISTS business_operation_graph_history_other_idx
  ON business_operation_graph_history (account_id, other_operation_id, id) WHERE other_operation_id IS NOT NULL;
-- Rejeu : résultat d'une commande déjà appliquée (clé d'idempotence par compte).
CREATE INDEX IF NOT EXISTS business_operation_graph_history_idem_idx
  ON business_operation_graph_history (account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
