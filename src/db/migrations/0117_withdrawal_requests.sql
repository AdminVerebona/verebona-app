-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0117 — Rétractation (CDC 6 §11)
--
-- Deux tables :
--   • withdrawal_requests            — la déclaration et son traitement
--   • withdrawal_verification_tokens — vérification de l'adresse, parcours public
--
-- ── CE QUE LES INSTANTANÉS PROTÈGENT ──────────────────────────────────────
-- Le §11 exige que « les snapshots permettent de prouver le contenu affiché et
-- confirmé sans dépendre de données modifiées ultérieurement ».
--
-- C'est le point le plus important de cette table. Une demande de rétractation
-- se conteste des mois plus tard, quand l'offre a changé de prix, quand
-- l'abonnement Stripe a été supprimé, quand le compte n'existe plus. Recalculer
-- alors le montant remboursable ou la date limite à partir de l'état courant
-- donnerait un résultat différent de celui que le consommateur a validé.
--
-- `declaration_snapshot_json` et `contract_snapshot_json` figent donc ce qui a
-- été affiché à l'écran au moment de la confirmation. Ils ne sont jamais
-- recalculés, et un déclencheur en interdit la modification.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Date de conclusion du contrat (§3.1) ──────────────────────────────────
--
-- « La date de référence est stockée dans le champ `contract_concluded_at`.
--   Elle correspond à la date et à l'heure de confirmation de la souscription
--   payante adressée à l'utilisateur. Elle ne doit pas être recalculée à partir
--   de données Stripe susceptibles d'être modifiées ultérieurement. »
--
-- Cette colonne n'existait pas : tout le calcul du délai légal en dépend.
--
-- Reprise de l'existant depuis `first_billed_at`, seule date de facturation
-- disponible sur les abonnements déjà en base. C'est une APPROXIMATION : le
-- §3.1 vise l'instant de confirmation adressée au client, que rien n'a
-- enregistré jusqu'ici. Pour les contrats antérieurs à cette migration, un
-- écart de quelques minutes est possible — sans conséquence sur un délai
-- exprimé en jours calendaires, mais à connaître.
--
-- Les contrats conclus après cette migration reçoivent la valeur exacte, posée
-- à la confirmation de la souscription.

ALTER TABLE account_subscriptions
  ADD COLUMN IF NOT EXISTS contract_concluded_at TIMESTAMPTZ;

UPDATE account_subscriptions
   SET contract_concluded_at = first_billed_at
 WHERE contract_concluded_at IS NULL
   AND first_billed_at IS NOT NULL;

COMMENT ON COLUMN account_subscriptions.contract_concluded_at IS
  'Confirmation de la souscription payante. Point de depart du delai de retractation (CDC 6 3.1).';

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id                        SERIAL      PRIMARY KEY,
  -- Référence communiquée au consommateur. Format RET-AAAAMMJJ-XXXXXX.
  public_reference          TEXT        NOT NULL UNIQUE,

  user_id                   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  account_id                INTEGER     REFERENCES accounts(id) ON DELETE SET NULL,
  subscription_id_internal  INTEGER     REFERENCES account_subscriptions(id) ON DELETE SET NULL,
  stripe_subscription_id    TEXT,

  -- §3.1 : date de référence, jamais recalculée depuis Stripe.
  contract_concluded_at     TIMESTAMPTZ,
  withdrawal_deadline_at    TIMESTAMPTZ,

  requested_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at              TIMESTAMPTZ,
  effective_at              TIMESTAMPTZ,

  -- authenticated | public | email | postal | support (§11)
  channel                   TEXT        NOT NULL DEFAULT 'authenticated',
  status                    TEXT        NOT NULL DEFAULT 'received',

  consumer_first_name       TEXT,
  consumer_last_name        TEXT,
  receipt_email             TEXT,

  declaration_snapshot_json TEXT,
  contract_snapshot_json    TEXT,

  amount_expected           INTEGER,       -- centimes
  amount_refunded           INTEGER        NOT NULL DEFAULT 0,
  currency                  TEXT           NOT NULL DEFAULT 'eur',
  stripe_refund_ids         TEXT,          -- JSON
  stripe_refund_statuses    TEXT,          -- JSON

  cancellation_status       TEXT        NOT NULL DEFAULT 'pending',
  failure_code              TEXT,
  failure_details           TEXT,

  receipt_sent_at           TIMESTAMPTZ,
  data_export_deadline_at   TIMESTAMPTZ,
  data_deletion_scheduled_at TIMESTAMPTZ,

  -- §12.4 : clé d'idempotence. Une double soumission ne crée pas deux
  -- déclarations, et le §7.4 exige que « le bouton ne puisse plus déclencher
  -- une seconde demande ».
  idempotency_key           TEXT,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT withdrawal_channel_check CHECK (channel IN
    ('authenticated', 'public', 'email', 'postal', 'support')),
  CONSTRAINT withdrawal_status_check CHECK (status IN (
    'received',       -- déclaration enregistrée (§7.4), traitement à venir
    'manual_review',  -- éligibilité indéterminable (§5.5)
    'processing',     -- annulation ou remboursement en cours
    'completed',      -- annulé et intégralement remboursé
    'failed',         -- échec nécessitant une intervention
    'rejected'        -- refusée après examen humain
  )),
  CONSTRAINT withdrawal_cancellation_check CHECK (cancellation_status IN
    ('pending', 'cancelled', 'failed', 'not_applicable')),
  -- Le montant remboursé ne peut pas dépasser l'attendu (§9.3 : « le montant
  -- final ne peut jamais dépasser le montant total effectivement encaissé »).
  CONSTRAINT withdrawal_amount_check CHECK (
    amount_expected IS NULL OR amount_refunded <= amount_expected
  ),
  CONSTRAINT withdrawal_amount_positive_check CHECK (
    amount_refunded >= 0 AND (amount_expected IS NULL OR amount_expected >= 0)
  )
);

-- §11 : « créer une contrainte empêchant plusieurs demandes actives pour le
-- même contrat ». Une demande close n'empêche pas une nouvelle souscription
-- suivie, le cas échéant, d'une nouvelle rétractation (§5.3).
CREATE UNIQUE INDEX IF NOT EXISTS withdrawal_active_per_contract_uidx
  ON withdrawal_requests (account_id, stripe_subscription_id)
  WHERE status IN ('received', 'manual_review', 'processing');

CREATE UNIQUE INDEX IF NOT EXISTS withdrawal_idempotency_uidx
  ON withdrawal_requests (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS withdrawal_user_idx ON withdrawal_requests (user_id);
CREATE INDEX IF NOT EXISTS withdrawal_account_idx ON withdrawal_requests (account_id);
CREATE INDEX IF NOT EXISTS withdrawal_status_idx ON withdrawal_requests (status);
CREATE INDEX IF NOT EXISTS withdrawal_email_idx ON withdrawal_requests (receipt_email);

-- ── Immutabilité de la preuve ─────────────────────────────────────────────
--
-- La déclaration est un acte juridique unilatéral : une fois reçue, son
-- contenu et son horodatage ne se corrigent pas. Seul le TRAITEMENT évolue.

CREATE OR REPLACE FUNCTION withdrawal_requests_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.public_reference       IS DISTINCT FROM OLD.public_reference
  OR NEW.requested_at           IS DISTINCT FROM OLD.requested_at
  OR NEW.confirmed_at           IS DISTINCT FROM OLD.confirmed_at
  OR NEW.contract_concluded_at  IS DISTINCT FROM OLD.contract_concluded_at
  OR NEW.withdrawal_deadline_at IS DISTINCT FROM OLD.withdrawal_deadline_at
  OR NEW.channel                IS DISTINCT FROM OLD.channel
  OR NEW.consumer_first_name    IS DISTINCT FROM OLD.consumer_first_name
  OR NEW.consumer_last_name     IS DISTINCT FROM OLD.consumer_last_name
  OR (OLD.declaration_snapshot_json IS NOT NULL
      AND NEW.declaration_snapshot_json IS DISTINCT FROM OLD.declaration_snapshot_json)
  OR (OLD.contract_snapshot_json IS NOT NULL
      AND NEW.contract_snapshot_json IS DISTINCT FROM OLD.contract_snapshot_json)
  THEN
    RAISE EXCEPTION
      'Demande % : la declaration et son horodatage sont figes (CDC retractation 7.4).',
      OLD.public_reference
      USING ERRCODE = 'restrict_violation';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS withdrawal_requests_guard_trg ON withdrawal_requests;
CREATE TRIGGER withdrawal_requests_guard_trg
  BEFORE UPDATE ON withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION withdrawal_requests_guard();

-- ── Vérification d'adresse, parcours public (§6.3) ────────────────────────
--
-- « Le système envoie un lien sécurisé à usage unique ou un code à l'adresse
-- du compte afin de vérifier que le demandeur contrôle cette adresse. »
--
-- Le jeton n'est pas stocké en clair : seule son empreinte l'est. Une fuite de
-- la base ne permettrait pas de rétracter les contrats d'autrui.

CREATE TABLE IF NOT EXISTS withdrawal_verification_tokens (
  id            SERIAL      PRIMARY KEY,
  token_hash    TEXT        NOT NULL UNIQUE,
  email         TEXT        NOT NULL,
  user_id       INTEGER     REFERENCES users(id) ON DELETE CASCADE,
  account_id    INTEGER     REFERENCES accounts(id) ON DELETE CASCADE,
  first_name    TEXT,
  last_name     TEXT,
  contract_reference TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  attempts      INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS withdrawal_tokens_email_idx
  ON withdrawal_verification_tokens (email);
CREATE INDEX IF NOT EXISTS withdrawal_tokens_expiry_idx
  ON withdrawal_verification_tokens (expires_at)
  WHERE consumed_at IS NULL;

COMMENT ON TABLE withdrawal_requests IS
  'Declarations de retractation (CDC 6). Declaration figee, traitement evolutif.';
COMMENT ON COLUMN withdrawal_requests.declaration_snapshot_json IS
  'Ce qui a ete affiche et confirme. Jamais recalcule (CDC 6 §11).';
COMMENT ON TABLE withdrawal_verification_tokens IS
  'Verification d adresse pour le parcours public. Empreinte seule, jamais le jeton.';
