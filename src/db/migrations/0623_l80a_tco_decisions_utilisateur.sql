-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0623 : coût de possession — décisions de l'utilisateur « Ajouter
-- au TCO » / « Retirer du TCO » (lot 80A, retour PO du 22/10/2026).
--
--   asset_cost_line_decisions — état COURANT : au plus une décision par bien
--     et par clé STABLE de ligne (`line_key`, voir
--     src/services/business-operations/tco/user-decisions.ts) :
--       f:<fichier>:<nature>:<montant>:<devise>   (justificatif du fait)
--       o:<Opération>:<nature>:<montant>:<devise> (composante sans justificatif)
--       asset:<bien>:acquisitionPrice / equipment:<équipement>:acquisitionPrice
--     La clé survit aux reconsolidations T3 (composante supersédée, Opération
--     fusionnée, candidat T1 renouvelé). `decision` : INCLUDE | EXCLUDE —
--     prioritaire sur les règles automatiques pour la ligne concernée. Annuler
--     une décision = supprimer sa ligne (retour aux règles automatiques),
--     toujours journalisé ci-dessous. `line_id`, montant, libellé, fichier :
--     contexte au moment de la décision (diagnostic BO), jamais relus comme
--     montant.
--
--   asset_cost_line_decision_events — JOURNAL append-only : qui, quand, geste
--     (INCLUDE | EXCLUDE | REVERT), décision précédente, statut et motif
--     automatiques remplacés, avertissement de doublon présenté et accepté.
--
-- Le bien porte le compte : les deux tables suivent le bien lors d'un
-- transfert (`ASSET_SCOPED_TABLES`, test L40 DUO-06). Garde d'isolation
-- (0373) : jamais le bien d'un autre compte. Supprimées avec le bien ou le
-- compte (CASCADE) ; auteur conservé à NULL si l'utilisateur est supprimé.
--
-- Nom sans « tco » (invariant INV-FINAL-013 : le TCO ne persiste aucune
-- vérité financière) : ces tables ne portent aucun total, seulement le CHOIX
-- de l'utilisateur, relu par le moteur à chaque calcul (comme les forfaits 0380).
--
-- Tables neuves (index dans 0623_..._idx_1, CONCURRENTLY). Idempotente.
-- Non déclarées dans Drizzle (lecture SQL directe, comme 0380). Retour
-- arrière : DROP TABLE IF EXISTS asset_cost_line_decision_events,
-- asset_cost_line_decisions (le moteur les ignore si absentes).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS asset_cost_line_decisions (
  id            BIGSERIAL    PRIMARY KEY,
  account_id    INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id      INTEGER      NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  line_key      TEXT         NOT NULL,
  decision      TEXT         NOT NULL,
  line_id       TEXT,
  amount_minor  BIGINT,
  currency      TEXT,
  label         TEXT,
  file_id       INTEGER      REFERENCES asset_files(id) ON DELETE SET NULL,
  decided_by    INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT asset_cost_line_decisions_decision_chk CHECK (decision IN ('INCLUDE', 'EXCLUDE')),
  CONSTRAINT asset_cost_line_decisions_key_chk CHECK (length(line_key) BETWEEN 1 AND 200),
  CONSTRAINT asset_cost_line_decisions_label_chk CHECK (label IS NULL OR length(label) <= 300),
  CONSTRAINT asset_cost_line_decisions_unique UNIQUE (account_id, asset_id, line_key)
);

COMMENT ON TABLE asset_cost_line_decisions IS
  'Lot 80A : décisions de l''utilisateur « Ajouter / Retirer du TCO » — une par bien et par clé stable de ligne ; prioritaires sur les règles automatiques ; réversibles (suppression journalisée).';

CREATE TABLE IF NOT EXISTS asset_cost_line_decision_events (
  id                 BIGSERIAL    PRIMARY KEY,
  account_id         INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id           INTEGER      NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  line_key           TEXT         NOT NULL,
  action             TEXT         NOT NULL,
  previous_decision  TEXT,
  line_id            TEXT,
  amount_minor       BIGINT,
  currency           TEXT,
  label              TEXT,
  file_id            INTEGER      REFERENCES asset_files(id) ON DELETE SET NULL,
  automatic_status   TEXT,
  automatic_reason   TEXT,
  duplicate_warning  TEXT,
  user_id            INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT asset_cost_line_decision_events_action_chk CHECK (action IN ('INCLUDE', 'EXCLUDE', 'REVERT')),
  CONSTRAINT asset_cost_line_decision_events_previous_chk CHECK (previous_decision IS NULL OR previous_decision IN ('INCLUDE', 'EXCLUDE'))
);

COMMENT ON TABLE asset_cost_line_decision_events IS
  'Lot 80A : journal append-only des gestes « Ajouter / Retirer du TCO » et de leurs annulations (qui, quand, résultat automatique remplacé, avertissement de doublon accepté).';

-- Garde d'isolation (0373) : une décision ne relie jamais un compte au bien d'un autre compte.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'account_isolation_link_guard') THEN
    DROP TRIGGER IF EXISTS asset_cost_line_decisions_isolation_guard ON asset_cost_line_decisions;
    CREATE TRIGGER asset_cost_line_decisions_isolation_guard
      BEFORE INSERT OR UPDATE OF asset_id ON asset_cost_line_decisions
      FOR EACH ROW EXECUTE FUNCTION account_isolation_link_guard('account', 'account_id', 'asset', 'asset_id');
    DROP TRIGGER IF EXISTS asset_cost_line_decision_events_isolation_guard ON asset_cost_line_decision_events;
    CREATE TRIGGER asset_cost_line_decision_events_isolation_guard
      BEFORE INSERT OR UPDATE OF asset_id ON asset_cost_line_decision_events
      FOR EACH ROW EXECUTE FUNCTION account_isolation_link_guard('account', 'account_id', 'asset', 'asset_id');
  END IF;
END $$;
