-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0219 : preuves canoniques, ciblées, et leur cycle de vie (CDC 15
-- T1-04, T1-05, T3-03, §12 « FieldEvidence : preuve active/superseded liée à
-- une cible et une canonicalKey », §14.4 « supersede les preuves d'anciennes
-- extractions en conservant la trace historique »).
-- Colonnes ici ; index dans 0219_*_idx_*.sql.
--
-- CIBLE : mêmes colonnes que `document_facts` (0218). `asset_id` reste le bien
-- PORTEUR (parent d'un équipement ou d'une pièce) ; `target_type` /
-- `target_entity_id` disent sur quoi porte réellement le fait. Les lecteurs
-- « champ du bien » ne retiennent que les preuves sans cible (historiques) ou
-- de cible ASSET — un numéro de série de chaudière n'est pas celui du bien.
--
-- CYCLE DE VIE, distinct de `status` :
--   · `status` (active | superseded | rejected | conflict) reste la DÉCISION
--     de réconciliation (T3) ;
--   · `lifecycle_status` (ACTIVE | SUPERSEDED | WITHDRAWN) dit si la preuve
--     appartient encore à l'analyse courante de sa source. Une réanalyse fait
--     passer les preuves antérieures en SUPERSEDED (jamais de DELETE), avec
--     `superseded_at` et, quand elle existe, la nouvelle preuve de même
--     clé/cible (`superseded_by_evidence_id`). WITHDRAWN : retrait (source
--     détachée ou supprimée, lot 13). Le remplacement ne touche JAMAIS
--     `status` ; les lecteurs filtrent `lifecycle_status`.
-- `analysis_run_id` ordonne les analyses d'une même source : seule une
-- analyse plus récente remplace (supersede sérialisé par verrou consultatif).
--
-- DONNÉES EXISTANTES : `lifecycle_status` prend 'ACTIVE' (défaut constant :
-- valeur de catalogue, AUCUNE réécriture de table, PG ≥ 11). Aucun rattrapage
-- ici : supersede des anciennes extractions = MIG-04 (lot 17).
-- Colonne NULLABLE (comme les autres) : le code traite NULL comme ACTIVE.
--
-- CONTRAINTE : CHECK ajouté `NOT VALID` — appliqué aux nouvelles lignes sans
-- balayer la table sous verrou. Les lignes existantes valent toutes 'ACTIVE'.
--
-- VERROUS : ADD COLUMN sous ACCESS EXCLUSIVE, `lock_timeout` 5 s ; dépassé,
-- la migration échoue, est signalée (/api/health) et retentée au prochain
-- démarrage — l'écriture des preuves se replie alors sur les colonnes
-- historiques (contrôle `evidence/canonical-columns`).
--
-- Idempotente : ADD COLUMN IF NOT EXISTS ; contrainte ajoutée si absente.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE field_evidence
  ADD COLUMN IF NOT EXISTS canonical_key             TEXT,
  ADD COLUMN IF NOT EXISTS canonical_unit            TEXT,
  ADD COLUMN IF NOT EXISTS raw_value                 TEXT,
  ADD COLUMN IF NOT EXISTS target_type               TEXT,
  ADD COLUMN IF NOT EXISTS target_entity_id          INTEGER,
  ADD COLUMN IF NOT EXISTS target_entity_label       TEXT,
  ADD COLUMN IF NOT EXISTS target_confidence         TEXT,
  ADD COLUMN IF NOT EXISTS semantic_event_type       TEXT,
  ADD COLUMN IF NOT EXISTS semantic_event_nature     TEXT,
  ADD COLUMN IF NOT EXISTS recurrence                JSONB,
  ADD COLUMN IF NOT EXISTS projection_origin         TEXT,
  ADD COLUMN IF NOT EXISTS projection_rule           TEXT,
  ADD COLUMN IF NOT EXISTS lifecycle_status          TEXT DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS superseded_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_by_evidence_id INTEGER,
  ADD COLUMN IF NOT EXISTS analysis_run_id           INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'field_evidence_lifecycle_status_ck'
                    AND conrelid = 'field_evidence'::regclass) THEN
    ALTER TABLE field_evidence
      ADD CONSTRAINT field_evidence_lifecycle_status_ck
      CHECK (lifecycle_status IS NULL OR lifecycle_status IN ('ACTIVE', 'SUPERSEDED', 'WITHDRAWN')) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN field_evidence.lifecycle_status IS
  'Cycle de vie (CDC 15 §14.4, T3-03) : ACTIVE | SUPERSEDED (réanalyse) | WITHDRAWN (retrait). Distinct de status (décision T3). NULL = ACTIVE.';
COMMENT ON COLUMN field_evidence.superseded_by_evidence_id IS
  'Nouvelle preuve de même clé/cible issue de la réanalyse de la même source, si elle existe (trace, sans clé étrangère).';
COMMENT ON COLUMN field_evidence.target_type IS
  'Cible du fait (CDC 15 T1-04). NULL = preuve historique, portée par asset_id.';
