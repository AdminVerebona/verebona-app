-- Migration 0058: Add web link fields to asset_files
--
-- Idempotent: safe to re-run

ALTER TABLE asset_files
  ADD COLUMN IF NOT EXISTS is_web_link boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS web_link_url text,
  ADD COLUMN IF NOT EXISTS web_link_title text;

CREATE INDEX IF NOT EXISTS asset_files_is_web_link_idx ON asset_files (is_web_link);
