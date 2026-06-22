-- Add home_category column to agenda_items for home page classification
-- 'action' = shown in "Prochaines dates" (can be "En retard")
-- 'information' = shown in "À savoir" (passive facts, never "En retard")
-- NULL = not yet classified (treated as 'action' as safe fallback)

ALTER TABLE agenda_items
  ADD COLUMN IF NOT EXISTS home_category TEXT,
  ADD CONSTRAINT agenda_items_home_category_check
    CHECK (home_category IS NULL OR home_category IN ('action', 'information'));

CREATE INDEX IF NOT EXISTS agenda_items_home_category_idx
  ON agenda_items (home_category);

-- Backfill: items with originType = 'asset_field' are informational by nature
-- (auto-generated from asset fields like warranty end date, etc.)
UPDATE agenda_items
  SET home_category = 'information'
  WHERE origin_type = 'asset_field'
    AND home_category IS NULL;
