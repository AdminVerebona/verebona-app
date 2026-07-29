-- Migration: Add CGSU acceptance tracking fields to users table
-- Created: 2025-12-09
--
-- Rendue idempotente : sans `IF NOT EXISTS`, un rejeu sur une base ou les
-- colonnes existent deja (creation initiale par `drizzle-kit push`) leve un
-- 42701 duplicate_column. Le lanceur de migrations sortait alors de sa boucle
-- et abandonnait silencieusement toutes les migrations suivantes.

ALTER TABLE users ADD COLUMN IF NOT EXISTS accepted_terms_at TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version TEXT;
