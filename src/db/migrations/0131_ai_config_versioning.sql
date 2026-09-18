-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0131 : versioning global de la configuration IA — CDC BO IA §4.1, §7
--
-- ══════════════════════════════════════════════════════════════════════════════
-- UNE VERSION, CINQ TRAITEMENTS
--
-- Le GEN-002 est catégorique : « une version IA représente un snapshot cohérent
-- de la configuration T1 à T5 ; il n'existe pas cinq versions indépendantes ».
--
-- C'est l'écart principal avec `ai_prompt_versions` (migration 0106), qui
-- versionne prompt par prompt. Un diff, un package de MEP et un rollback y
-- portent sur un prompt ; ici ils portent sur l'ensemble. Les deux modèles ne
-- se superposent pas — le second remplace le premier, qui sera retiré une fois
-- le BO en service.
--
-- Le contenu est découpé par traitement (`ai_config_entries`, cinq lignes par
-- version) et non stocké en un bloc unique. Deux exigences l'imposent : le
-- WF-01 demande un enregistrement explicite onglet par onglet, et le WF-02 que
-- les erreurs de validation soient présentées « par traitement et par champ ».
--
-- ══════════════════════════════════════════════════════════════════════════════
-- LES INVARIANTS SONT EN BASE, PAS DANS LE CODE
--
-- Une seule Active et un seul À tester par environnement : ce sont des index
-- uniques partiels, comme la 0106 l'a fait pour les prompts. Sur un hébergement
-- à plusieurs instances, une garantie applicative ne tient pas — deux requêtes
-- concurrentes peuvent lire « aucune Active » et en écrire chacune une.
--
-- Le VER-013 exige qu'une collision de numéro bloque l'import « sans
-- renumérotation automatique ». C'est donc une contrainte d'unicité, pas une
-- vérification préalable : une vérification laisse passer la course, la
-- contrainte non.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- CE QUI N'EST PAS ICI, ET POURQUOI
--
-- Le GEN-001 sépare configuration versionnée et état opérationnel runtime.
-- N'entrent donc pas dans ces tables : l'état Activé/Désactivé/Suspendu d'un
-- traitement, l'Emergency Stop, les compteurs de circuit breaker, la file, les
-- exécutions et les credentials. Le VER-011 le confirme pour le package.
--
-- La conséquence est concrète : un rollback de configuration ne doit jamais
-- rallumer un traitement que quelqu'un venait de couper.
--
-- Idempotente. Aucune donnée existante n'est touchée.
-- ──────────────────────────────────────────────────────────────────────────────

-- ── Versions globales ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_config_versions (
  id               SERIAL      PRIMARY KEY,

  -- Identifiant technique stable, né avec la version et conservé lors du
  -- transport préproduction → production. C'est lui qui permet au WF-04 de
  -- reconnaître un package déjà importé au lieu de le dupliquer.
  uid              UUID        NOT NULL DEFAULT gen_random_uuid(),

  -- Provenance, pas cloisonnement : préproduction et production ont des bases
  -- distinctes, l'isolation du GEN-003 est déjà structurelle. Cette colonne dit
  -- d'où vient la version, et empêche qu'un package de préproduction soit pris
  -- pour une version née en production.
  environment      TEXT        NOT NULL,

  status           TEXT        NOT NULL DEFAULT 'DRAFT',

  -- Numéro visible vN. NULL tant que la version n'a pas été validée : le
  -- VER-006 ne l'attribue qu'à ce moment. Un Brouillon n'a donc pas de numéro,
  -- et c'est voulu — le numéroter donnerait à croire qu'il existe.
  visible_number   INTEGER,

  label            TEXT,

  -- Version dont ce Brouillon est dérivé. Sert au diff du VER-003 et à la
  -- détection d'obsolescence du WF-01.
  base_version_id  INTEGER     REFERENCES ai_config_versions(id) ON DELETE SET NULL,

  -- « Obsolète » est un ATTRIBUT, pas un statut (§4.1) : un Brouillon obsolète
  -- reste un Brouillon. Le confondre avec un statut interdirait de le corriger.
  is_stale         BOOLEAN     NOT NULL DEFAULT FALSE,

  created_by       INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  validated_by     INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  validated_at     TIMESTAMPTZ,
  activated_by     INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  activated_at     TIMESTAMPTZ,
  archived_at      TIMESTAMPTZ,

  CONSTRAINT ai_config_versions_env_check
    CHECK (environment IN ('local', 'preprod', 'production')),

  CONSTRAINT ai_config_versions_status_check
    CHECK (status IN ('DRAFT', 'TO_TEST', 'ACTIVE', 'VALIDATED', 'ARCHIVED')),

  -- Le VER-006 : le numéro naît à la validation. Une version numérotée sans
  -- date de validation, ou validée sans numéro, serait un état incohérent
  -- qu'aucun écran ne saurait afficher.
  CONSTRAINT ai_config_versions_number_check
    CHECK ((visible_number IS NULL) = (validated_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_config_versions_uid_uidx
  ON ai_config_versions(uid);

-- ⚠️ VER-001 et « une seule Active simultanément » (WF-05) : garantis par la
-- base. Ce sont les deux invariants dont dépend tout le reste — quelle
-- configuration s'applique, et laquelle est en cours de test.
CREATE UNIQUE INDEX IF NOT EXISTS ai_config_versions_single_active_idx
  ON ai_config_versions(environment) WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS ai_config_versions_single_to_test_idx
  ON ai_config_versions(environment) WHERE status = 'TO_TEST';

-- VER-013 : une collision de numéro bloque, sans renumérotation automatique.
CREATE UNIQUE INDEX IF NOT EXISTS ai_config_versions_number_uidx
  ON ai_config_versions(environment, visible_number) WHERE visible_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_config_versions_lookup_idx
  ON ai_config_versions(environment, status);

COMMENT ON TABLE ai_config_versions IS
  'Versions globales de la configuration IA T1-T5 (CDC BO IA GEN-002). '
  'Une version = un instantané cohérent des cinq traitements.';

-- ── Contenu, une ligne par traitement ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_config_entries (
  id               SERIAL      PRIMARY KEY,
  version_id       INTEGER     NOT NULL REFERENCES ai_config_versions(id) ON DELETE CASCADE,

  -- T1 à T5. Le code de traitement, pas le code d'usage du référentiel : le BO
  -- parle de T1-T5, le référentiel de SOURCE_ANALYSIS et consorts. La
  -- correspondance est bijective et vit dans le code, pas en base — une
  -- correspondance dupliquée finit par diverger.
  treatment        TEXT        NOT NULL,

  -- Prompt administrable unique du traitement (T1-013, T3-007, T4-010).
  -- Sans limite de taille imposée par le BO (SCR-02).
  prompt           TEXT        NOT NULL DEFAULT '',

  primary_model    TEXT,
  fallback_1       TEXT,
  fallback_2       TEXT,

  reasoning_primary    TEXT,
  reasoning_fallback_1 TEXT,
  reasoning_fallback_2 TEXT,

  -- §2.1 : max output tokens du modèle PRINCIPAL uniquement. Les fallbacks
  -- héritent ; il n'y a donc rien à saisir ni à valider pour eux.
  max_output_tokens    INTEGER,

  -- Garde-fous choisis dans un catalogue fermé, chacun avec seuil et réaction.
  -- JSONB parce que la forme d'un garde-fou dépend de son code ; le catalogue
  -- lui-même reste dans le code et change avec une mise en production.
  guardrails       JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- Déclencheurs : événements et planifications, vides pour T2 et T5 qui sont
  -- synchrones et hors file globale (GEN-004).
  triggers         JSONB       NOT NULL DEFAULT '[]'::jsonb,

  updated_by       INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ai_config_entries_treatment_check
    CHECK (treatment IN ('T1', 'T2', 'T3', 'T4', 'T5')),

  CONSTRAINT ai_config_entries_tokens_check
    CHECK (max_output_tokens IS NULL OR max_output_tokens > 0)
);

-- Un traitement apparaît une fois et une seule par version : c'est ce qui rend
-- « cinq lignes par version » vérifiable plutôt qu'espéré.
CREATE UNIQUE INDEX IF NOT EXISTS ai_config_entries_version_treatment_uidx
  ON ai_config_entries(version_id, treatment);

COMMENT ON TABLE ai_config_entries IS
  'Configuration d''un traitement au sein d''une version globale. '
  'Cinq lignes par version, une par traitement T1-T5.';

-- ── Packages de mise en production ──────────────────────────────────────────
--
-- Le VER-010 : « le package est immuable et reste valable même si l'Active
-- Préproduction évolue ensuite ». Il porte donc une COPIE du contenu, jamais
-- une référence à la version source — une référence suivrait les évolutions et
-- le package cesserait d'être immuable.
CREATE TABLE IF NOT EXISTS ai_config_packages (
  id                 SERIAL      PRIMARY KEY,
  uid                UUID        NOT NULL,
  source_environment TEXT        NOT NULL,
  visible_number     INTEGER     NOT NULL,
  label              TEXT,

  -- Instantané complet des cinq traitements au moment du packaging.
  -- Le VER-011 en exclut secrets, credentials, états runtime, file,
  -- exécutions et Emergency Stop : rien de tout cela n'est lu ici.
  payload            JSONB       NOT NULL,

  created_by         INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Renseignés à l'arrivée en production, pour que le WF-04 reconnaisse un
  -- package déjà importé au lieu d'en créer un second.
  imported_at        TIMESTAMPTZ,
  imported_version_id INTEGER    REFERENCES ai_config_versions(id) ON DELETE SET NULL,

  CONSTRAINT ai_config_packages_env_check
    CHECK (source_environment IN ('local', 'preprod', 'production'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_config_packages_uid_uidx
  ON ai_config_packages(uid);

COMMENT ON TABLE ai_config_packages IS
  'Packages immuables de MEP (CDC BO IA VER-010, VER-011). '
  'Portent une copie du contenu, jamais une référence à la version source.';
