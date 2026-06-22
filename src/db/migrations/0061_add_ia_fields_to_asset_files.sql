-- V3.3 IA fields for asset_files (missing from previous migrations)
ALTER TABLE asset_files
  ADD COLUMN IF NOT EXISTS is_ignored BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS retained_title TEXT,
  ADD COLUMN IF NOT EXISTS retained_function_code TEXT,
  ADD COLUMN IF NOT EXISTS cil_rubric_codes JSON,
  ADD COLUMN IF NOT EXISTS extracted_text TEXT,
  ADD COLUMN IF NOT EXISTS last_analysis_at TIMESTAMPTZ;
