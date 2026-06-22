-- Migration 0068: Referral V1
-- Ajoute stripe_invoice_id sur referral_events (idempotence webhook)
-- Crée referral_email_sends (logs d'envoi, emails hashés RGPD)

ALTER TABLE "referral_events"
  ADD COLUMN IF NOT EXISTS "stripe_invoice_id" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'referral_events_stripe_invoice_id_unique'
  ) THEN
    ALTER TABLE "referral_events"
      ADD CONSTRAINT "referral_events_stripe_invoice_id_unique" UNIQUE("stripe_invoice_id");
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "referral_email_sends" (
  "id" serial PRIMARY KEY NOT NULL,
  "referral_link_id" integer NOT NULL,
  "sender_account_id" integer NOT NULL,
  "recipient_email_hash" text NOT NULL,
  "sent_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "referral_email_sends_referral_link_id_fk"
    FOREIGN KEY ("referral_link_id") REFERENCES "referral_links"("id") ON DELETE cascade,
  CONSTRAINT "referral_email_sends_sender_account_id_fk"
    FOREIGN KEY ("sender_account_id") REFERENCES "accounts"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "referral_email_sends_link_id_idx" ON "referral_email_sends" ("referral_link_id");
CREATE INDEX IF NOT EXISTS "referral_email_sends_sender_idx" ON "referral_email_sends" ("sender_account_id");
