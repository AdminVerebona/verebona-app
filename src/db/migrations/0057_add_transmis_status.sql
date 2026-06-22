-- Migration 0057: Add TRANSMIS to assets status check constraint
--
-- Run with: psql ... -f 0057_add_transmis_status.sql
-- Idempotent: safe to re-run

ALTER TABLE assets
  DROP CONSTRAINT IF EXISTS assets_status_check;

ALTER TABLE assets
  ADD CONSTRAINT assets_status_check
    CHECK (status IN ('EN_SERVICE', 'EN_MAINTENANCE', 'HORS_SERVICE', 'ARCHIVED', 'TRANSMIS'));
