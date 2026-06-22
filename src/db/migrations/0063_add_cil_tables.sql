-- Migration 0063: CIL Réglementaire tables
-- Adds: asset_cil_profiles, energy_materials, equipment_cil_specs, energy_works, cil_block_resolutions, document_cil_metadata

CREATE TABLE IF NOT EXISTS asset_cil_profiles (
  id SERIAL PRIMARY KEY,
  public_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  asset_id INTEGER NOT NULL UNIQUE REFERENCES assets(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL DEFAULT 'inconnu'
    CONSTRAINT asset_cil_profiles_trigger_type_check
      CHECK (trigger_type IN ('construction','renovation_energetique','volontaire','inconnu')),
  trigger_date DATE,
  authorization_type TEXT,
  voluntary_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS asset_cil_profiles_asset_id_idx ON asset_cil_profiles(asset_id);

CREATE TABLE IF NOT EXISTS energy_materials (
  id SERIAL PRIMARY KEY,
  public_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  category TEXT NOT NULL
    CONSTRAINT energy_materials_category_check
      CHECK (category IN ('toiture','murs_exterieurs','parois_vitrees','planchers_bas')),
  material_nature TEXT,
  brand TEXT,
  reference TEXT,
  thermal_resistance_r NUMERIC,
  lambda NUMERIC,
  thickness_mm INTEGER,
  surface_sqm NUMERIC,
  interface_treatment TEXT,
  document_id INTEGER REFERENCES asset_files(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS energy_materials_asset_id_idx ON energy_materials(asset_id);

CREATE TABLE IF NOT EXISTS equipment_cil_specs (
  id SERIAL PRIMARY KEY,
  equipment_id INTEGER NOT NULL UNIQUE REFERENCES equipments(id) ON DELETE CASCADE,
  brand TEXT,
  model TEXT,
  energy_type TEXT,
  evacuation_mode TEXT,
  serial_number TEXT,
  power_kw NUMERIC,
  energy_label TEXT,
  heat_network_delivery_station TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS equipment_cil_specs_equipment_id_idx ON equipment_cil_specs(equipment_id);

CREATE TABLE IF NOT EXISTS energy_works (
  id SERIAL PRIMARY KEY,
  public_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  agenda_item_id INTEGER REFERENCES agenda_items(id) ON DELETE SET NULL,
  category TEXT NOT NULL
    CONSTRAINT energy_works_category_check
      CHECK (category IN ('isolation_toiture','isolation_murs','isolation_parois','isolation_planchers','chauffage','refroidissement','ecs','ventilation','enr')),
  title TEXT NOT NULL,
  description TEXT,
  completed_at DATE,
  company_name TEXT,
  material_ids TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS energy_works_asset_id_idx ON energy_works(asset_id);

CREATE TABLE IF NOT EXISTS cil_block_resolutions (
  id SERIAL PRIMARY KEY,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  resolution TEXT NOT NULL
    CONSTRAINT cil_block_resolutions_resolution_check
      CHECK (resolution IN ('not_applicable','unknown_confirmed')),
  justification TEXT,
  resolved_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cil_block_resolutions_asset_block_idx UNIQUE (asset_id, block_id)
);
CREATE INDEX IF NOT EXISTS cil_block_resolutions_asset_id_idx ON cil_block_resolutions(asset_id);

CREATE TABLE IF NOT EXISTS document_cil_metadata (
  id SERIAL PRIMARY KEY,
  asset_file_id INTEGER NOT NULL UNIQUE REFERENCES asset_files(id) ON DELETE CASCADE,
  plan_state TEXT
    CONSTRAINT document_cil_metadata_plan_state_check
      CHECK (plan_state IS NULL OR plan_state IN ('conception','execution')),
  cil_category TEXT,
  include_in_annex BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS document_cil_metadata_asset_file_id_idx ON document_cil_metadata(asset_file_id);
