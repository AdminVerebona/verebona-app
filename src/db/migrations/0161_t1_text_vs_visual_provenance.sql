-- 0161 — T1 : distinguer le texte LU des observations VISUELLES.
--
-- Jusqu'ici toute preuve était un extrait littéral (colonnes NOT NULL). Une
-- information purement visuelle (« chaudière murale » sur une photo) devait
-- donc disparaître ou recevoir un faux extrait. Chaque preuve porte désormais
-- sa provenance :
--   · TEXT_EXTRACTION : extrait littéral obligatoire ;
--   · VISUAL_ANALYSIS : preuve visuelle (page, image, zone, description),
--                       et AUCUN extrait — la contrainte l'interdit.
-- Les lignes existantes sont toutes des lectures : défaut TEXT_EXTRACTION.
-- Contraintes NOT VALID : elles s'imposent à toute nouvelle écriture sans
-- bloquer la migration sur une ligne historique atypique.

-- ── Représentation du document ─────────────────────────────────────────────
ALTER TABLE document_extractions ADD COLUMN IF NOT EXISTS visual_summary TEXT;
ALTER TABLE document_extractions ADD COLUMN IF NOT EXISTS visual_observations JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ── Faits ──────────────────────────────────────────────────────────────────
ALTER TABLE document_facts ADD COLUMN IF NOT EXISTS evidence_origin TEXT NOT NULL DEFAULT 'TEXT_EXTRACTION';
ALTER TABLE document_facts ADD COLUMN IF NOT EXISTS visual_evidence JSONB;
ALTER TABLE document_facts ALTER COLUMN excerpt DROP NOT NULL;
ALTER TABLE document_facts DROP CONSTRAINT IF EXISTS document_facts_evidence_ck;
ALTER TABLE document_facts ADD CONSTRAINT document_facts_evidence_ck CHECK (
  (evidence_origin = 'TEXT_EXTRACTION' AND excerpt IS NOT NULL AND btrim(excerpt) <> '')
  OR (evidence_origin = 'VISUAL_ANALYSIS' AND excerpt IS NULL AND visual_evidence ? 'description')
) NOT VALID;
CREATE INDEX IF NOT EXISTS document_facts_origin_idx ON document_facts (file_id, evidence_origin) WHERE status = 'active';

-- ── Preuves par champ (réconciliation) ─────────────────────────────────────
ALTER TABLE field_evidence ADD COLUMN IF NOT EXISTS evidence_origin TEXT NOT NULL DEFAULT 'TEXT_EXTRACTION';
ALTER TABLE field_evidence ADD COLUMN IF NOT EXISTS visual_evidence JSONB;
ALTER TABLE field_evidence ALTER COLUMN evidence_excerpt DROP NOT NULL;
ALTER TABLE field_evidence DROP CONSTRAINT IF EXISTS field_evidence_origin_ck;
ALTER TABLE field_evidence ADD CONSTRAINT field_evidence_origin_ck CHECK (
  (evidence_origin = 'TEXT_EXTRACTION' AND evidence_excerpt IS NOT NULL)
  OR (evidence_origin = 'VISUAL_ANALYSIS' AND evidence_excerpt IS NULL AND visual_evidence ? 'description')
) NOT VALID;
