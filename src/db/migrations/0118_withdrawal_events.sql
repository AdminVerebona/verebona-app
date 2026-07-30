-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0118 — Journal d'événements de rétractation (CDC 6 §18)
--
-- ── POURQUOI UNE TABLE D'ÉVÉNEMENTS, ALORS QUE LA DEMANDE PORTE DÉJÀ SON
--    STATUT ────────────────────────────────────────────────────────────────
--
-- Le §18 se termine par deux phrases qui commandent tout ce fichier :
--
--   « La preuve ne doit pas pouvoir être modifiée silencieusement. Les
--     corrections administratives doivent être ajoutées sous forme
--     d'événements complémentaires. »
--
-- Les colonnes de `withdrawal_requests` portent l'ÉTAT COURANT : statut,
-- montant remboursé, code d'échec. Elles sont écrasées à chaque étape. Elles
-- répondent à « où en est-on ? », jamais à « que s'est-il passé ? ».
--
-- Or c'est la seconde question qui se pose en cas de litige : à quelle heure
-- la déclaration a-t-elle été reçue, quel remboursement a échoué et pourquoi,
-- quel administrateur est intervenu, quand. Un statut écrasé ne le dira
-- jamais.
--
-- D'où ce journal en ajout seul. Un déclencheur interdit toute modification et
-- toute suppression : une correction s'écrit comme un événement de plus, pas
-- comme une réécriture du précédent.
--
-- Les dix-huit éléments listés au §18 s'y consignent, chacun rattaché à sa
-- demande et horodaté.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS withdrawal_events (
  id                BIGSERIAL   PRIMARY KEY,
  withdrawal_id     INTEGER     NOT NULL REFERENCES withdrawal_requests(id) ON DELETE CASCADE,
  public_reference  TEXT        NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  event_type        TEXT        NOT NULL,
  -- 'consumer' | 'system' | 'stripe' | 'admin:<id>'
  actor             TEXT        NOT NULL DEFAULT 'system',
  actor_user_id     INTEGER     REFERENCES users(id) ON DELETE SET NULL,

  result            TEXT        NOT NULL DEFAULT 'success',
  summary           TEXT        NOT NULL,
  -- Détail structuré. Les données sensibles y sont masquées à l'écriture
  -- (§16 : « masquage des données sensibles dans les journaux »).
  payload_json      TEXT,

  CONSTRAINT withdrawal_events_result_check CHECK (result IN ('success', 'failure', 'info')),
  CONSTRAINT withdrawal_events_type_check CHECK (event_type IN (
    -- Parcours (§18, éléments 1 à 10)
    'JOURNEY_VIEWED',
    'DECLARATION_RECEIVED',
    'RECEIPT_SENT',
    -- Traitement Stripe (éléments 11 à 15)
    'SUBSCRIPTION_CANCELLED',
    'SUBSCRIPTION_CANCEL_FAILED',
    'PAYMENTS_IDENTIFIED',
    'REFUND_REQUESTED',
    'REFUND_STATUS_CHANGED',
    'WEBHOOK_RECEIVED',
    -- Cycle de vie du compte (éléments 17 et 18)
    'EXPORT_ONLY_ENTERED',
    'DELETION_SCHEDULED',
    'DELETION_EXECUTED',
    'DELETION_CANCELLED',
    -- Interventions humaines (élément 16)
    'ADMIN_NOTE',
    'ADMIN_RETRY',
    'ADMIN_MANUAL_REFUND',
    'ADMIN_STATUS_CHANGED',
    'ADMIN_REJECTED'
  ))
);

CREATE INDEX IF NOT EXISTS withdrawal_events_request_idx
  ON withdrawal_events (withdrawal_id, occurred_at);
CREATE INDEX IF NOT EXISTS withdrawal_events_reference_idx
  ON withdrawal_events (public_reference);
CREATE INDEX IF NOT EXISTS withdrawal_events_type_idx
  ON withdrawal_events (event_type, occurred_at);

-- ── Ajout seul ────────────────────────────────────────────────────────────
--
-- Ni modification, ni suppression. C'est la traduction littérale de « la
-- preuve ne doit pas pouvoir être modifiée silencieusement » : l'interdiction
-- est posée au niveau du moteur, et non laissée à la discipline du code.

CREATE OR REPLACE FUNCTION withdrawal_events_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Journal de retractation : ajout seul. Une correction s ecrit comme un evenement complementaire (CDC 6 18).'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS withdrawal_events_no_update_trg ON withdrawal_events;
CREATE TRIGGER withdrawal_events_no_update_trg
  BEFORE UPDATE ON withdrawal_events
  FOR EACH ROW EXECUTE FUNCTION withdrawal_events_append_only();

-- La suppression reste possible par cascade depuis la demande — sans quoi la
-- suppression d'un compte échouerait. Une suppression DIRECTE, elle, est
-- refusée : c'est la seule qui trahirait une réécriture d'historique.
CREATE OR REPLACE FUNCTION withdrawal_events_no_direct_delete() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM withdrawal_requests WHERE id = OLD.withdrawal_id) THEN
    RAISE EXCEPTION
      'Journal de retractation : suppression interdite tant que la demande existe (CDC 6 18).'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS withdrawal_events_no_delete_trg ON withdrawal_events;
CREATE TRIGGER withdrawal_events_no_delete_trg
  BEFORE DELETE ON withdrawal_events
  FOR EACH ROW EXECUTE FUNCTION withdrawal_events_no_direct_delete();

COMMENT ON TABLE withdrawal_events IS
  'Journal en ajout seul des retractations (CDC 6 18). Une correction est un evenement de plus.';
