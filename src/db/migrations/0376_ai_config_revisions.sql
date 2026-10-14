-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0376 : versions, révisions restaurables et exports de la
-- Configuration IA — lot 54 (54C), ticket « BO-IA — Refonte de la gestion des
-- versions, restauration et export de la Configuration IA ».
--
-- ══════════════════════════════════════════════════════════════════════════════
-- CE QUI CHANGE
--
--   · Plus de workflow Brouillon → À tester → Validé → Archivé : une version
--     est ACTIVE (une seule par environnement, index unique partiel existant
--     `ai_config_versions_single_active_idx`) ou INACTIVE. La version active
--     reste modifiable.
--   · Chaque sauvegarde effective crée une RÉVISION (`ai_config_revisions`) :
--     instantané complet et autonome (JSON), numéroté par version, IMMUABLE
--     (déclencheur : aucune mise à jour). `ai_config_entries` reste la copie
--     de travail de la révision courante (lue par les écrans existants).
--   · Suppression LOGIQUE (`deleted_at`) : jamais de la version active
--     (contrainte), révisions conservées.
--   · Exports (`ai_config_exports`) : texte exact du fichier téléchargé et son
--     empreinte, IMMUABLES (déclencheur : ni mise à jour ni suppression).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REPRISE DES DONNÉES EXISTANTES — SANS CHANGER LA CONFIGURATION EN SERVICE
--
--   · La configuration réellement appliquée aux nouveaux démarrages avant
--     cette migration était : hors production, la version « À tester » si
--     elle existait (VER-004), sinon l'« Active ». C'est ELLE qui devient la
--     version active : aucune exécution ne change de configuration au
--     déploiement. L'ancienne « Active » devient non active, réactivable en un
--     clic. Le statut d'origine est conservé (`legacy_status`).
--   · Brouillon, À tester (restant), Validée → non active ; Archivée → non
--     active et supprimée logiquement (récupérable depuis « Versions
--     supprimées »). Rien n'est détruit.
--   · Les versions sans numéro (brouillons) reçoivent le numéro suivant, dans
--     l'ordre de création ; les numéros existants (v1, v2…) sont inchangés.
--   · Chaque version reçoit sa révision 1 (« reprise automatique »), copie
--     exacte de ses lignes (T1, T2, T3, T4, T6 ; une ligne T5 historique reste
--     en base, hors instantané — lot 49). La version active y fige aussi les
--     prompts maîtres actifs (référence, empreinte et texte).
--
-- Idempotente : colonnes et tables `IF NOT EXISTS`, contraintes recréées,
-- reprise limitée aux lignes non encore reprises (`current_revision_id IS
-- NULL`, statuts historiques). Rejouable sans effet.
-- ──────────────────────────────────────────────────────────────────────────────

-- ── 1. Colonnes des versions ───────────────────────────────────────────────
ALTER TABLE ai_config_versions
  ADD COLUMN IF NOT EXISTS description             TEXT,
  ADD COLUMN IF NOT EXISTS deleted_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by              INTEGER,
  ADD COLUMN IF NOT EXISTS current_revision_id     INTEGER,
  ADD COLUMN IF NOT EXISTS current_revision_number INTEGER,
  ADD COLUMN IF NOT EXISTS updated_by              INTEGER,
  ADD COLUMN IF NOT EXISTS legacy_status           TEXT;

COMMENT ON COLUMN ai_config_versions.legacy_status IS
  'Statut d''origine avant la refonte du lot 54 (DRAFT, TO_TEST, VALIDATED, ARCHIVED, ACTIVE). Information seulement.';
COMMENT ON COLUMN ai_config_versions.deleted_at IS
  'Suppression logique (lot 54) : retirée de la liste, révisions conservées et restaurables. Jamais sur la version active.';

-- ── 2. Contraintes ─────────────────────────────────────────────────────────
-- Le numéro naît désormais à la création (plus à la validation).
ALTER TABLE ai_config_versions DROP CONSTRAINT IF EXISTS ai_config_versions_number_check;

-- Statuts : ACTIVE / INACTIVE. Les anciennes valeurs restent ACCEPTÉES (une
-- sauvegarde antérieure doit rester restaurable) ; le code n'en écrit plus.
ALTER TABLE ai_config_versions DROP CONSTRAINT IF EXISTS ai_config_versions_status_check;
ALTER TABLE ai_config_versions ADD CONSTRAINT ai_config_versions_status_check
  CHECK (status IN ('ACTIVE', 'INACTIVE', 'DRAFT', 'TO_TEST', 'VALIDATED', 'ARCHIVED'));

-- ── 3. Révisions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_config_revisions (
  id                        SERIAL      PRIMARY KEY,
  version_id                INTEGER     NOT NULL REFERENCES ai_config_versions(id) ON DELETE CASCADE,
  revision_number           INTEGER     NOT NULL,
  -- Instantané complet et autonome : { format, entries[], masterPrompts{} }.
  snapshot                  JSONB       NOT NULL,
  -- Empreinte du JSON canonique (clés triées), calculée par l'application.
  -- NULL pour les révisions de reprise (calculée à la lecture).
  snapshot_sha256           TEXT,
  kind                      TEXT        NOT NULL,
  comment                   TEXT,
  -- Restauration : révision d'origine (même version ou version supprimée).
  restored_from_revision_id INTEGER,
  -- Duplication : version d'origine.
  source_version_id         INTEGER,
  -- Pas de clé étrangère vers `users` : la ligne est immuable (une mise à
  -- NULL en cascade serait refusée par le déclencheur). L'e-mail est figé.
  created_by                INTEGER,
  created_by_email          TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_config_revisions_kind_check
    CHECK (kind IN ('migration', 'create', 'duplicate', 'save', 'restore', 'master_prompt')),
  CONSTRAINT ai_config_revisions_number_check CHECK (revision_number > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_config_revisions_version_number_uidx
  ON ai_config_revisions(version_id, revision_number);

COMMENT ON TABLE ai_config_revisions IS
  'Révisions restaurables des versions de configuration IA (lot 54). Instantané complet, immuable, indépendant des traces d''exécution.';

CREATE OR REPLACE FUNCTION ai_config_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Ligne immuable (%) : % refusé (lot 54, historique de la configuration IA).', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END $$;

DROP TRIGGER IF EXISTS ai_config_revisions_immutable ON ai_config_revisions;
CREATE TRIGGER ai_config_revisions_immutable BEFORE UPDATE ON ai_config_revisions
  FOR EACH ROW EXECUTE FUNCTION ai_config_immutable_guard();

-- ── 4. Exports ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_config_exports (
  id                    SERIAL      PRIMARY KEY,
  export_uid            UUID        NOT NULL DEFAULT gen_random_uuid(),
  environment           TEXT        NOT NULL,
  version_id            INTEGER,
  version_uid           UUID,
  version_number        INTEGER     NOT NULL,
  revision_id           INTEGER,
  revision_number       INTEGER     NOT NULL,
  file_name             TEXT        NOT NULL,
  format_version        TEXT        NOT NULL,
  -- Texte EXACT du fichier téléchargé : le relire rend les mêmes octets.
  content               TEXT        NOT NULL,
  content_sha256        TEXT        NOT NULL,
  -- Empreinte de la seule configuration (sans horodatage ni auteur) : sert à
  -- dire si la configuration a changé depuis cet export.
  configuration_sha256  TEXT        NOT NULL,
  exported_by           INTEGER,
  exported_by_email     TEXT,
  exported_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_config_exports_uid_uidx ON ai_config_exports(export_uid);
CREATE INDEX IF NOT EXISTS ai_config_exports_env_at_idx ON ai_config_exports(environment, exported_at DESC);

COMMENT ON TABLE ai_config_exports IS
  'Historique des exports de la configuration IA active (lot 54) : fichier exact, empreinte, version/révision, auteur. Immuable.';

DROP TRIGGER IF EXISTS ai_config_exports_immutable ON ai_config_exports;
CREATE TRIGGER ai_config_exports_immutable BEFORE UPDATE OR DELETE ON ai_config_exports
  FOR EACH ROW EXECUTE FUNCTION ai_config_immutable_guard();

-- ── 5. Reprise des statuts (sans changer la configuration en service) ──────
DO $$
DECLARE
  env TEXT;
BEGIN
  -- 5a. Hors production : la version « À tester » était la configuration
  -- EFFECTIVE (VER-004). Ordre imposé par l'index unique « une seule
  -- active » : l'ancienne active d'abord, puis la promue.
  FOR env IN
    SELECT DISTINCT environment FROM ai_config_versions
     WHERE status = 'TO_TEST' AND environment <> 'production'
  LOOP
    UPDATE ai_config_versions
       SET legacy_status = COALESCE(legacy_status, status), status = 'INACTIVE', updated_at = NOW()
     WHERE environment = env AND status = 'ACTIVE';
    UPDATE ai_config_versions
       SET legacy_status = COALESCE(legacy_status, status), status = 'ACTIVE',
           activated_at = COALESCE(activated_at, NOW()), updated_at = NOW()
     WHERE environment = env AND status = 'TO_TEST';
  END LOOP;

  -- 5b. Archivée → non active, supprimée logiquement (récupérable).
  UPDATE ai_config_versions
     SET legacy_status = COALESCE(legacy_status, status), status = 'INACTIVE',
         deleted_at = COALESCE(deleted_at, archived_at, NOW()), updated_at = NOW()
   WHERE status = 'ARCHIVED';

  -- 5c. Brouillon, À tester restant (production), Validée → non active.
  UPDATE ai_config_versions
     SET legacy_status = COALESCE(legacy_status, status), status = 'INACTIVE', updated_at = NOW()
   WHERE status IN ('DRAFT', 'TO_TEST', 'VALIDATED');

  -- 5d. Active : statut d'origine mémorisé.
  UPDATE ai_config_versions SET legacy_status = 'ACTIVE' WHERE status = 'ACTIVE' AND legacy_status IS NULL;
END $$;

-- La version active n'est jamais supprimée (après reprise : aucune ligne ne
-- la viole).
ALTER TABLE ai_config_versions DROP CONSTRAINT IF EXISTS ai_config_versions_active_not_deleted;
ALTER TABLE ai_config_versions ADD CONSTRAINT ai_config_versions_active_not_deleted
  CHECK (status <> 'ACTIVE' OR deleted_at IS NULL);

-- ── 6. Numéros des versions qui n'en avaient pas ───────────────────────────
WITH base AS (
  SELECT environment, COALESCE(MAX(visible_number), 0) AS m
    FROM ai_config_versions GROUP BY environment
), num AS (
  SELECT v.id, b.m + ROW_NUMBER() OVER (PARTITION BY v.environment ORDER BY v.created_at, v.id) AS n
    FROM ai_config_versions v JOIN base b ON b.environment = v.environment
   WHERE v.visible_number IS NULL
)
UPDATE ai_config_versions v SET visible_number = num.n FROM num WHERE v.id = num.id;

-- ── 7. Révision 1 de chaque version (copie exacte de ses lignes) ───────────
DO $$
DECLARE
  master_col TEXT := 'NULL::text';
  refs TEXT := '''{}''::jsonb';
  exec_expr TEXT := 'NULL::jsonb';
BEGIN
  -- Colonnes facultatives (migrations antérieures éventuellement en échec).
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
              AND table_name = 'ai_config_entries' AND column_name = 'master_prompt') THEN
    master_col := 'NULLIF(btrim(e.master_prompt), '''')';
  END IF;

  IF to_regclass('ai_master_prompt_versions') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                AND table_name = 'ai_master_prompt_versions' AND column_name = 'execution_mode') THEN
      exec_expr := 'CASE WHEN p.execution_mode IS NULL THEN NULL ELSE jsonb_build_object('
        || '''mode'', CASE WHEN p.execution_mode = ''STRUCTURED_CONTEXT'' THEN ''STRUCTURED_CONTEXT'' ELSE ''LEGACY_TEMPLATE'' END, '
        || '''inputContractVersion'', p.input_contract_version, '
        || '''outputContractVersion'', p.output_contract_version, '
        || '''allowedTasks'', p.allowed_tasks) END';
    END IF;
    -- Prompts maîtres ACTIFS figés dans la révision de la version active.
    refs := 'CASE WHEN v.status = ''ACTIVE'' THEN COALESCE((SELECT jsonb_object_agg(p.treatment, jsonb_build_object('
      || '''versionId'', p.id, ''versionNumber'', p.version_number, ''masterPromptCode'', p.master_prompt_code, '
      || '''contentSha256'', p.content_sha256, ''content'', p.content, ''execution'', ' || exec_expr || '))'
      || ' FROM ai_master_prompt_versions p WHERE p.environment = v.environment AND p.status = ''ACTIVE'''
      || ' AND p.treatment IN (''T1'', ''T2'', ''T3'', ''T4'', ''T6'')), ''{}''::jsonb) ELSE ''{}''::jsonb END';
  END IF;

  EXECUTE
    'INSERT INTO ai_config_revisions (version_id, revision_number, snapshot, kind, comment, created_by, created_at) '
    || 'SELECT v.id, 1, jsonb_build_object(''format'', ''ai-config-snapshot-v1'', ''entries'', COALESCE(('
    || '  SELECT jsonb_agg(jsonb_build_object('
    || '    ''treatment'', e.treatment, ''prompt'', COALESCE(e.prompt, ''''), '
    || '    ''primaryModel'', e.primary_model, ''fallback1'', e.fallback_1, ''fallback2'', e.fallback_2, '
    || '    ''reasoningPrimary'', e.reasoning_primary, ''reasoningFallback1'', e.reasoning_fallback_1, '
    || '    ''reasoningFallback2'', e.reasoning_fallback_2, ''maxOutputTokens'', e.max_output_tokens, '
    || '    ''guardrails'', COALESCE(e.guardrails, ''[]''::jsonb), ''triggers'', COALESCE(e.triggers, ''[]''::jsonb), '
    || '    ''cascade'', e.cascade, ''promptArchitecture'', ''master'', ''masterPrompt'', ' || master_col
    || '  ) ORDER BY e.treatment) FROM ai_config_entries e '
    || '  WHERE e.version_id = v.id AND e.treatment IN (''T1'', ''T2'', ''T3'', ''T4'', ''T6'')'
    || '), ''[]''::jsonb), ''masterPrompts'', ' || refs || '), '
    || '''migration'', ''Reprise automatique (lot 54) — statut d''''origine : '' || COALESCE(v.legacy_status, v.status), '
    || 'v.created_by, COALESCE(v.updated_at, v.created_at) '
    || 'FROM ai_config_versions v WHERE v.current_revision_id IS NULL '
    || 'AND NOT EXISTS (SELECT 1 FROM ai_config_revisions r WHERE r.version_id = v.id) '
    || 'ON CONFLICT (version_id, revision_number) DO NOTHING';

  UPDATE ai_config_versions v
     SET current_revision_id = r.id, current_revision_number = r.revision_number
    FROM ai_config_revisions r
   WHERE v.current_revision_id IS NULL AND r.version_id = v.id
     AND r.revision_number = (SELECT MAX(r2.revision_number) FROM ai_config_revisions r2 WHERE r2.version_id = v.id);
END $$;
