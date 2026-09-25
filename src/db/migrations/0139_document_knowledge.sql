-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0139 — Représentation durable du contenu d'un document (T1)
--
-- ── POURQUOI ──────────────────────────────────────────────────────────────
--
-- T1 est le traitement unique d'analyse documentaire. Après son passage, les
-- autres usages (T2 assistant, T3 réconciliation, T4 agenda, traitements
-- futurs) doivent pouvoir exploiter le contenu du document SANS relire le
-- fichier original, qui reste la preuve de référence.
--
-- Jusqu'ici, T1 ne conservait durablement que quelques colonnes de
-- `asset_files` (titre, description, texte, fournisseur, montant, date) et,
-- UNIQUEMENT si un bien était identifié, des preuves par champ
-- (`field_evidence.asset_id` est NOT NULL). Un document non rattaché perdait
-- donc ses faits ; une information sans colonne métier n'était lisible que
-- dans un blob texte (`document_analysis_runs.raw_response_json`).
--
-- ── TROIS NIVEAUX, TROIS PLACES ───────────────────────────────────────────
--
--   1. Contenu source extrait   → `document_extractions` (une ligne courante
--      par document) : texte intégral, description, titre, date, émetteur,
--      montant, métadonnées, preuves des éléments structurants.
--   2. Faits génériques         → `document_facts` : « Chaudière / puissance
--      / 24 / kW », avec unité, période, confiance, extrait justificatif,
--      localisation (page, zone, sélecteur…) et provenance (modèle, prompt).
--      Aucun bien requis.
--   3. Projections métier       → inchangé : `field_evidence` puis
--      `assets.key_characteristics` via la réconciliation (T3). Elles peuvent
--      désormais être produites plus tard, depuis les faits persistés, au
--      rattachement du document à un bien — sans relecture du fichier.
--
-- ── HISTORIQUE ────────────────────────────────────────────────────────────
--
-- Une nouvelle analyse remplace la ligne courante de `document_extractions`
-- et fait passer les faits précédents en `superseded` (ils restent
-- consultables, jamais supprimés par T1).
--
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS document_extractions (
  id                 SERIAL PRIMARY KEY,
  account_id         INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id            INTEGER NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  analysis_run_id    INTEGER REFERENCES document_analysis_runs(id) ON DELETE SET NULL,
  -- Bien rattaché AU MOMENT de l'analyse (information, pas contrainte).
  asset_id_at_analysis INTEGER,
  engine             TEXT NOT NULL DEFAULT 'source_analysis',   -- source_analysis | legacy
  source_type        TEXT NOT NULL DEFAULT 'asset_file',        -- asset_file | web_link
  source_version     INTEGER,
  -- Niveau 1 — contenu source
  title              TEXT,
  description        TEXT,
  document_date      DATE,
  supplier_name      TEXT,
  supplier_siret     TEXT,
  amount_cents       BIGINT,
  currency           TEXT NOT NULL DEFAULT 'EUR',
  full_text          TEXT,
  full_text_chars    INTEGER NOT NULL DEFAULT 0,
  document_type_code TEXT,
  rubric_code        TEXT,
  has_exploitable_content BOOLEAN NOT NULL DEFAULT true,
  -- Preuve de chaque élément structurant : { title: {confidence, excerpt, location}, … }
  structural_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Métadonnées utiles : avertissements, candidats de rattachement, dates
  -- d'agenda repérées, nombre de sources groupées…
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  fact_count         INTEGER NOT NULL DEFAULT 0,
  -- Provenance de l'extraction
  provider           TEXT,
  model              TEXT,
  prompt_version     TEXT,
  operation_trace_id TEXT,
  extracted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS document_extractions_file_uidx ON document_extractions (file_id);
CREATE INDEX IF NOT EXISTS document_extractions_account_idx ON document_extractions (account_id);
-- Recherche plein texte (T2, niveau 2) : français, sans accents requis côté requête.
CREATE INDEX IF NOT EXISTS document_extractions_fts_idx ON document_extractions
  USING GIN (to_tsvector('french', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(supplier_name, '') || ' ' || coalesce(full_text, '')));

CREATE TABLE IF NOT EXISTS document_facts (
  id                 BIGSERIAL PRIMARY KEY,
  account_id         INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id            INTEGER NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  extraction_id      INTEGER NOT NULL REFERENCES document_extractions(id) ON DELETE CASCADE,
  -- Clé libre produite par T1 (ex. `heatingPowerKw`, `boiler.power`).
  fact_key           TEXT NOT NULL,
  -- Décomposition générique : sujet / attribut / valeur / unité.
  subject            TEXT,          -- « Chaudière »
  attribute          TEXT,          -- « puissance »
  label              TEXT,          -- libellé lisible, si fourni
  value_text         TEXT,
  value_number       NUMERIC,
  value_unit         TEXT,          -- « kW »
  value_json         JSONB,         -- valeur brute telle que produite
  normalized_value   TEXT,
  period_start       DATE,
  period_end         DATE,
  -- Confiance et preuve
  confidence         TEXT NOT NULL, -- certain | probable | conflictual
  excerpt            TEXT NOT NULL,
  location           JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {page, section, selector, charStart, charEnd}
  -- Provenance
  source_type        TEXT NOT NULL DEFAULT 'asset_file',
  provider           TEXT,
  model              TEXT,
  prompt_version     TEXT,
  status             TEXT NOT NULL DEFAULT 'active',      -- active | superseded
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_facts_status_check CHECK (status IN ('active', 'superseded')),
  CONSTRAINT document_facts_confidence_check CHECK (confidence IN ('certain', 'probable', 'conflictual'))
);

CREATE INDEX IF NOT EXISTS document_facts_file_idx ON document_facts (file_id, status);
CREATE INDEX IF NOT EXISTS document_facts_account_key_idx ON document_facts (account_id, fact_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS document_facts_fts_idx ON document_facts
  USING GIN (to_tsvector('french', coalesce(fact_key, '') || ' ' || coalesce(subject, '') || ' ' || coalesce(attribute, '') || ' ' || coalesce(label, '') || ' ' || coalesce(value_text, '')))
  WHERE status = 'active';

COMMENT ON TABLE document_extractions IS
  'T1 — contenu source extrait d''un document (ligne courante). Exploitable sans relire le fichier.';
COMMENT ON TABLE document_facts IS
  'T1 — faits génériques extraits d''un document, avec preuve et provenance. Aucun bien requis.';

-- La réconciliation (T3) peut désormais être déclenchée par le rattachement
-- d'un document déjà analysé à un bien : projection depuis les faits
-- persistés, sans relecture du fichier.
ALTER TABLE reconciliation_runs DROP CONSTRAINT IF EXISTS reconciliation_runs_trigger_check;
ALTER TABLE reconciliation_runs ADD CONSTRAINT reconciliation_runs_trigger_check
  CHECK (triggered_by IN ('document_analyzed', 'document_linked', 'manual', 'scheduled', 'field_changed'));
