-- ============================================================================
-- 0075 — Socle multicanal de notifications (CDC Notifications §12)
--
-- Sépare l'événement métier (outbox) de ses livraisons (deliveries), une par
-- canal et, pour le push, par appareil. Ajoute les préférences par utilisateur
-- et les abonnements Web Push. Fait évoluer la table `notifications` (cloche)
-- pour un contenu rendu côté serveur (title/body/href/category + outbox_id).
--
-- Idempotent : rejouable sans effet de bord (IF NOT EXISTS partout).
-- ============================================================================

-- §12.1 — Préférences par utilisateur (jamais au niveau du compte partagé) ----
CREATE TABLE IF NOT EXISTS notification_preferences (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category       TEXT NOT NULL,
  delivery_mode  TEXT NOT NULL DEFAULT 'immediate',
  channel        TEXT NOT NULL,
  enabled        BOOLEAN NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notification_preferences_delivery_mode_check
    CHECK (delivery_mode IN ('immediate','daily_digest')),
  CONSTRAINT notification_preferences_channel_check
    CHECK (channel IN ('push','email')),
  CONSTRAINT notification_preferences_unique
    UNIQUE (user_id, category, delivery_mode, channel)
);

CREATE INDEX IF NOT EXISTS notification_preferences_user_id_idx
  ON notification_preferences (user_id);

-- §12.2 — Abonnements Web Push (un par appareil) ------------------------------
-- endpoint + clés = données sensibles de capacité : jamais en clair dans les
-- logs applicatifs ; chiffrement applicatif au repos recommandé (Lot 2).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh_key      TEXT NOT NULL,
  auth_key        TEXT NOT NULL,
  user_agent      TEXT,
  platform        TEXT,
  device_label    TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  failure_count   INTEGER NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT push_subscriptions_status_check
    CHECK (status IN ('active','revoked','expired','failed'))
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx ON push_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS push_subscriptions_status_idx  ON push_subscriptions (status);

-- §12.3 — Outbox : file persistante des événements métier ---------------------
CREATE TABLE IF NOT EXISTS notification_outbox (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type        TEXT NOT NULL,
  category          TEXT,
  account_id        INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  recipient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entity_type       TEXT,
  entity_id         TEXT,
  payload_json      JSONB,
  deep_link         TEXT,
  priority          TEXT NOT NULL DEFAULT 'normal',
  mandatory_bell    BOOLEAN NOT NULL DEFAULT FALSE,
  mandatory_email   BOOLEAN NOT NULL DEFAULT FALSE,
  dedupe_key        TEXT NOT NULL UNIQUE,
  scheduled_for     TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'pending',
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at      TIMESTAMPTZ,
  CONSTRAINT notification_outbox_priority_check
    CHECK (priority IN ('low','normal','high')),
  CONSTRAINT notification_outbox_status_check
    CHECK (status IN ('pending','processing','sent','partial','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS notification_outbox_recipient_idx
  ON notification_outbox (recipient_user_id);
-- Scrutation du dispatcher : événements dus et non terminés.
CREATE INDEX IF NOT EXISTS notification_outbox_due_idx
  ON notification_outbox (status, scheduled_for);

-- §12.4 — Journal de livraison multicanal -------------------------------------
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id            UUID NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel              TEXT NOT NULL,
  push_subscription_id UUID REFERENCES push_subscriptions(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  provider_message_id  TEXT,
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  last_error_code      TEXT,
  last_error_message   TEXT,
  attempted_at         TIMESTAMPTZ,
  sent_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notification_deliveries_channel_check
    CHECK (channel IN ('bell','push','email')),
  CONSTRAINT notification_deliveries_status_check
    CHECK (status IN ('pending','sent','failed','skipped_preference','skipped_unavailable','expired'))
);

CREATE INDEX IF NOT EXISTS notification_deliveries_outbox_id_idx
  ON notification_deliveries (outbox_id);
CREATE INDEX IF NOT EXISTS notification_deliveries_channel_status_idx
  ON notification_deliveries (channel, status);

-- §12.5 — Évolution de la table cloche `notifications` ------------------------
-- Contenu rendu côté serveur ; `type` et `payload_json` conservés pour les
-- interactions spécifiques et le fallback des lignes historiques (§22.1).
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS outbox_id UUID;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS title     TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS body      TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS href      TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS category  TEXT;

CREATE INDEX IF NOT EXISTS notifications_outbox_id_idx ON notifications (outbox_id);

COMMENT ON TABLE notification_outbox IS
  'Source unique des événements métier de notification (CDC §11/§12). Aucun service ne doit insérer directement une notification pour un événement couvert par le CDC.';
COMMENT ON TABLE notification_deliveries IS
  'Journal de livraison par canal et par appareil (CDC §12.4). Contenu minimisé : aucune donnée patrimoniale.';
COMMENT ON COLUMN push_subscriptions.endpoint IS
  'Donnée sensible de capacité — ne jamais journaliser en clair (CDC §12.2/§19.2).';
