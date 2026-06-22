-- Migration: Add CGSU acceptance tracking fields to users table
-- Created: 2025-12-09

ALTER TABLE users ADD COLUMN accepted_terms_at TEXT;
ALTER TABLE users ADD COLUMN terms_version TEXT;
