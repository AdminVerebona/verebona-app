-- Migration 0071: Referral V2 — Signup contexts + promo codes + enriched statuses
-- Complète le modèle pour supporter le CDC Parrainage signup

-- 1. Promo codes table
CREATE TABLE IF NOT EXISTS "promo_codes" (
  "id" serial PRIMARY KEY NOT NULL,
  "code" text NOT NULL UNIQUE,
  "status" text NOT NULL DEFAULT 'active',
  "campaign_id" text,
  "valid_from" timestamptz,
  "valid_until" timestamptz,
  "target_offer" text,
  "stripe_promotion_code_id" text,
  "max_redemptions" integer,
  "redemption_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "promo_codes_code_idx" ON "promo_codes" ("code");
CREATE INDEX IF NOT EXISTS "promo_codes_status_idx" ON "promo_codes" ("status");

-- 2. Signup contexts table
CREATE TABLE IF NOT EXISTS "signup_contexts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "entry_point" text NOT NULL DEFAULT 'direct_signup',
  "target_offer" text,
  "raw_code" text,
  "code_source" text,
  "resolved_code_type" text,
  "resolved_code_id" integer,
  "validation_status" text NOT NULL DEFAULT 'pending',
  "validation_message" text,
  "stripe_promotion_code_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL DEFAULT (now() + interval '7 days')
);

CREATE INDEX IF NOT EXISTS "signup_contexts_created_at_idx" ON "signup_contexts" ("created_at");

-- 3. Enrichir referral_events avec les nouveaux statuts CDC
-- Ajout des colonnes nécessaires si elles n'existent pas déjà
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'referral_events' AND column_name = 'stripe_subscription_id'
  ) THEN
    ALTER TABLE "referral_events" ADD COLUMN "stripe_subscription_id" text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'referral_events' AND column_name = 'signup_context_id'
  ) THEN
    ALTER TABLE "referral_events" ADD COLUMN "signup_context_id" uuid;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'referral_events' AND column_name = 'captured_at'
  ) THEN
    ALTER TABLE "referral_events" ADD COLUMN "captured_at" timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'referral_events' AND column_name = 'confirmed_at'
  ) THEN
    ALTER TABLE "referral_events" ADD COLUMN "confirmed_at" timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'referral_events' AND column_name = 'rewarded_at'
  ) THEN
    ALTER TABLE "referral_events" ADD COLUMN "rewarded_at" timestamptz;
  END IF;
END $$;