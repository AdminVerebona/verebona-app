-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0119 — Référentiel de catégories documentaires (CDC 5 §8)
--
-- ── LE CONSTAT CRITIQUE QUE CETTE MIGRATION CORRIGE ───────────────────────
--
-- Le §1.3 le pose en tête de ses constats critiques :
--
--   « Le champ asset_files.document_type est obligatoire et vaut AUTRE par
--     défaut. Impossible de distinguer une vraie classification "Autre" d'un
--     document encore incertain. »
--
-- C'est la faute fondatrice. Aujourd'hui, un document que l'IA n'a pas su
-- classer et un document délibérément rangé en « Autre » sont indiscernables :
-- les deux portent `AUTRE`. Aucun compteur, aucun tri, aucune reprise ne peut
-- distinguer « je ne sais pas » de « ce n'est rien de précis ».
--
-- D'où `classification_state`, état système à deux valeurs, indépendant du
-- type. Le §2.2 le formule ainsi : « À classer ne fait pas partie du
-- référentiel des catégories », et le §1.3 en fait une contrainte majeure —
-- « À classer est un état système et ne doit jamais être représenté par le
-- type AUTRE ».
--
-- ── POURQUOI `document_type` DEVIENT NULLABLE ─────────────────────────────
--
-- Le §8.2 le demande : « une nouvelle ligne peut conserver un type nullable
-- tant que classification_state = TO_CLASSIFY ». Sans cela, le défaut `AUTRE`
-- resterait obligatoire et le problème se reproduirait à chaque dépôt.
--
-- Les lignes existantes ne sont pas touchées : elles conservent leur valeur.
-- La reprise est traitée plus bas, avec sa limite documentée.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Catégories ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS document_categories (
  id                 SERIAL      PRIMARY KEY,
  code               TEXT        NOT NULL UNIQUE,
  generic_label      TEXT        NOT NULL,
  description        TEXT,
  is_active          BOOLEAN     NOT NULL DEFAULT TRUE,
  -- AUTRES_DOCUMENTS est obligatoire et non désactivable (§6.1).
  is_system_required BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Ordre par défaut, surchargeable par type de bien (§3.2).
  display_order      INTEGER     NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Une catégorie obligatoire ne peut pas être désactivée. Poser la règle en
-- base évite qu'un futur écran d'administration ne l'oublie et ne laisse un
-- document sans catégorie de dernier recours.
ALTER TABLE document_categories
  DROP CONSTRAINT IF EXISTS document_categories_system_active_check;
ALTER TABLE document_categories
  ADD CONSTRAINT document_categories_system_active_check
    CHECK (NOT is_system_required OR is_active);

-- ── 2. Applicabilité par type de bien, et libellés contextualisés (§3.3) ──

CREATE TABLE IF NOT EXISTS document_category_asset_associations (
  id                   SERIAL      PRIMARY KEY,
  category_id          INTEGER     NOT NULL REFERENCES document_categories(id) ON DELETE CASCADE,
  -- NULL = applicable à toutes les familles de biens (§3.2, colonne « Tous »).
  asset_type_id        INTEGER     REFERENCES asset_types(id) ON DELETE CASCADE,
  -- Réservé aux cas où l'applicabilité dépend de la sous-catégorie
  -- (§3.2 : « selon sous-catégories OBJECT »).
  asset_subcategory_code TEXT,
  contextual_label     TEXT,
  display_order        INTEGER     NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Une seule règle par couple. `COALESCE` neutralise le fait qu'en SQL deux
-- NULL ne sont jamais égaux : sans lui, la règle « toutes familles » pourrait
-- être insérée deux fois.
CREATE UNIQUE INDEX IF NOT EXISTS document_category_asset_uidx
  ON document_category_asset_associations (
    category_id, COALESCE(asset_type_id, -1), COALESCE(asset_subcategory_code, '')
  );

-- ── 3. Compatibilité type ↔ catégorie (§4.3) ──────────────────────────────

CREATE TABLE IF NOT EXISTS document_category_type_associations (
  id               SERIAL      PRIMARY KEY,
  category_id      INTEGER     NOT NULL REFERENCES document_categories(id) ON DELETE CASCADE,
  document_type_id INTEGER     NOT NULL REFERENCES document_types(id) ON DELETE CASCADE,
  is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS document_category_type_uidx
  ON document_category_type_associations (category_id, document_type_id);
CREATE INDEX IF NOT EXISTS document_category_type_type_idx
  ON document_category_type_associations (document_type_id) WHERE is_active;

-- ── 4. Signal d'échec de classification (§5.2, §7.3) ──────────────────────
--
-- « Le reclassement manuel constitue un signal d'échec de classification de
-- l'IA. » Sans cette table, ce signal serait perdu : on saurait que la valeur
-- a changé, jamais ce que l'IA avait proposé ni avec quelle confiance.

CREATE TABLE IF NOT EXISTS document_classification_feedback (
  id                    SERIAL      PRIMARY KEY,
  file_id               INTEGER     NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  proposed_category_id  INTEGER     REFERENCES document_categories(id) ON DELETE SET NULL,
  proposed_type_code    TEXT,
  corrected_category_id INTEGER     REFERENCES document_categories(id) ON DELETE SET NULL,
  corrected_type_code   TEXT,
  category_confidence   NUMERIC(4,3),
  type_confidence       NUMERIC(4,3),
  pipeline_version      TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_classification_feedback_file_idx
  ON document_classification_feedback (file_id);
CREATE INDEX IF NOT EXISTS document_classification_feedback_created_idx
  ON document_classification_feedback (created_at DESC);

-- ── 5. Correctifs de référentiel (§6.3) ───────────────────────────────────
--
-- « Un correctif publié ne peut pas être annulé par un bouton de rollback. »
-- L'absence de retour arrière impose une trace : sans elle, un correctif mal
-- ciblé serait irréparable ET inexplicable.

CREATE TABLE IF NOT EXISTS document_reference_corrections (
  id                  SERIAL      PRIMARY KEY,
  executed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_by         INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  correction_type     TEXT        NOT NULL,
  description         TEXT        NOT NULL,
  -- Correspondance avant/après, telle que confirmée par l'administrateur.
  mapping_json        TEXT,
  -- Nombre de documents annoncé à la confirmation (§6.3, étape 2).
  impact_count        INTEGER     NOT NULL DEFAULT 0,
  -- Nombre réellement modifié. Un écart avec le précédent signale que la
  -- base a bougé entre l'aperçu et la confirmation.
  applied_count       INTEGER     NOT NULL DEFAULT 0,
  unmatched_count     INTEGER     NOT NULL DEFAULT 0,

  CONSTRAINT document_reference_corrections_type_check CHECK (correction_type IN (
    'CATEGORY_RENAMED', 'CATEGORY_DEACTIVATED', 'CATEGORY_MERGED',
    'TYPE_CATEGORY_REMAPPED', 'TYPE_DEACTIVATED'
  ))
);

-- Ajout seul : un correctif inannulable doit laisser une trace inaltérable.
CREATE OR REPLACE FUNCTION document_reference_corrections_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Correctif de referentiel : trace inaltérable (CDC 5 6.3). Aucun rollback nest prevu.'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS document_reference_corrections_guard_trg
  ON document_reference_corrections;
CREATE TRIGGER document_reference_corrections_guard_trg
  BEFORE UPDATE OR DELETE ON document_reference_corrections
  FOR EACH ROW EXECUTE FUNCTION document_reference_corrections_append_only();

-- ── 6. Évolution de asset_files (§8.2) ────────────────────────────────────

ALTER TABLE asset_files
  ADD COLUMN IF NOT EXISTS document_category_id INTEGER
    REFERENCES document_categories(id) ON DELETE SET NULL;

ALTER TABLE asset_files
  ADD COLUMN IF NOT EXISTS classification_state TEXT NOT NULL DEFAULT 'TO_CLASSIFY';

-- Scores internes. Le §8.2 est formel : « jamais exposé au front utilisateur ».
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS category_confidence NUMERIC(4,3);
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS type_confidence     NUMERIC(4,3);

ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS category_source TEXT;
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS type_source     TEXT;

-- Verrouillages du §5.2 : une valeur corrigée à la main n'est plus touchée
-- par l'IA. Sans eux, le traitement de cohérence réécrirait les corrections
-- de l'utilisateur — le pire comportement possible pour sa confiance.
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS category_user_locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS type_user_locked     BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS classification_updated_at TIMESTAMPTZ;

ALTER TABLE asset_files DROP CONSTRAINT IF EXISTS asset_files_classification_state_check;
ALTER TABLE asset_files
  ADD CONSTRAINT asset_files_classification_state_check
    CHECK (classification_state IN ('CLASSIFIED', 'TO_CLASSIFY'));

ALTER TABLE asset_files DROP CONSTRAINT IF EXISTS asset_files_category_source_check;
ALTER TABLE asset_files
  ADD CONSTRAINT asset_files_category_source_check
    -- 'RULE' ajoutée par 0120 : alignée ici pour que l'ordre soit indifférent.
    CHECK (category_source IS NULL OR category_source IN
      ('AI', 'USER', 'REFERENCE_CORRECTION', 'RULE'));

ALTER TABLE asset_files DROP CONSTRAINT IF EXISTS asset_files_type_source_check;
ALTER TABLE asset_files
  ADD CONSTRAINT asset_files_type_source_check
    CHECK (type_source IS NULL OR type_source IN
      ('AI', 'USER', 'REFERENCE_CORRECTION', 'RULE'));

-- `document_type` devient nullable (§8.2). La valeur par défaut `AUTRE` est
-- retirée : c'est elle qui rendait indiscernables « Autre » et « non classé ».
ALTER TABLE asset_files ALTER COLUMN document_type DROP NOT NULL;
ALTER TABLE asset_files ALTER COLUMN document_type DROP DEFAULT;

CREATE INDEX IF NOT EXISTS asset_files_classification_state_idx
  ON asset_files (classification_state);
CREATE INDEX IF NOT EXISTS asset_files_category_idx
  ON asset_files (document_category_id);

-- ── 7. Reprise des documents existants ────────────────────────────────────
--
-- ⚠️ TOUS LES DOCUMENTS EXISTANTS PASSENT EN `TO_CLASSIFY`.
--
-- C'est le défaut de la colonne, et c'est délibéré : aucun d'eux n'a de
-- catégorie, et le §2.3 exige catégorie ET type compatibles pour être classé.
-- Les déclarer classés sur la foi du seul type produirait des compteurs faux.
--
-- Le §7.2 prévoit précisément ce rattrapage : le traitement de cohérence
-- reclassera ces documents. Le CDC note par ailleurs que « l'environnement
-- cible ne contient pas encore de documents utilisateurs à migrer » — à
-- vérifier avant déploiement si ce n'est plus le cas.
--
-- Seule exception : les documents dont le type valait `AUTRE` par défaut sans
-- décision réelle. On ne peut pas les distinguer des « Autre » délibérés —
-- c'est exactement le défaut que cette migration corrige — donc on ne tente
-- rien : ils partent tous en `TO_CLASSIFY`, comme les autres.

COMMENT ON COLUMN asset_files.classification_state IS
  'CLASSIFIED ou TO_CLASSIFY. Etat systeme, jamais represente par le type AUTRE (CDC 5 1.3).';
COMMENT ON COLUMN asset_files.category_confidence IS
  'Score interne. Jamais expose au front utilisateur (CDC 5 8.2).';
COMMENT ON TABLE document_categories IS
  'Referentiel des categories documentaires (CDC 5 3.2).';
