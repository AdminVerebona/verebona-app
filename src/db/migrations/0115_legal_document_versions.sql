-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0115 — Versionnement et acceptation des CGVU (CDC 7)
--
-- Trois tables :
--   • legal_document_versions — une ligne par version, figée à la publication
--   • legal_acceptances       — la preuve contractuelle, jamais modifiée
--   • legal_audit_log         — le journal du §19
--
-- ── ÉCART ASSUMÉ N°1 : IDENTIFIANTS ────────────────────────────────────────
-- Le §14 décrit `user_id`, `published_by` et `subscription_id` en UUID. Tout
-- le dépôt utilise des entiers `serial` pour ces mêmes entités. Introduire des
-- UUID ici imposerait une table de correspondance et des jointures hybrides,
-- pour aucun gain. Les entiers sont conservés ; seul l'identifiant de version
-- reste un UUID, comme le §7 l'exige explicitement.
--
-- ── ÉCART ASSUMÉ N°2 : LE HTML EST STOCKÉ EN BASE ──────────────────────────
-- Le §14.1 prévoit `html_storage_key`, ce qui suggère un stockage externe. La
-- colonne existe et est renseignée, mais le contenu est AUSSI conservé en base
-- dans `html_content`, qui fait foi.
--
-- Les cinq exigences du §16.1 — clé unique, écrasement interdit, droits de
-- suppression limités, sauvegarde indépendante, service sans génération
-- dynamique — sont mieux tenues ainsi : le déclencheur ci-dessous rend la
-- modification impossible au niveau du moteur, et la sauvegarde de la base
-- emporte les CGVU. Un répertoire statique dans un conteneur qui se réinitialise
-- ne tiendrait aucune des cinq. Le §16.1 autorise d'ailleurs explicitement
-- « un répertoire statique dédié » comme alternative au stockage objet.
--
-- Une copie est écrite sur le stockage objet quand il est configuré, mais le
-- permalien n'en dépend pas (§16.3 : « ne pas dépendre de l'existence du
-- compte utilisateur », et par extension d'un service tiers).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Versions ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS legal_document_versions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type       TEXT        NOT NULL DEFAULT 'CGVU',
  version_code        TEXT        NOT NULL,
  title               TEXT        NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'DRAFT',
  effective_at        TIMESTAMPTZ,
  published_at        TIMESTAMPTZ,
  published_by        INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  change_summary      TEXT        NOT NULL,
  -- Qualification du §17. Décidée avant publication, jamais devinée.
  requires_reacceptance BOOLEAN   NOT NULL DEFAULT FALSE,
  -- Contenu figé. Fait foi (cf. écart n°2).
  html_content        TEXT,
  html_storage_key    TEXT,
  permalink           TEXT,
  sha256              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT legal_versions_type_check
    CHECK (document_type IN ('CGVU')),
  CONSTRAINT legal_versions_status_check
    CHECK (status IN ('DRAFT', 'PUBLISHED', 'CURRENT', 'ARCHIVED')),
  -- Une version publiée porte obligatoirement ses éléments de preuve.
  CONSTRAINT legal_versions_published_complete_check CHECK (
    status = 'DRAFT' OR (
      published_at IS NOT NULL AND effective_at IS NOT NULL AND
      html_content IS NOT NULL AND sha256 IS NOT NULL AND
      permalink IS NOT NULL AND html_storage_key IS NOT NULL
    )
  )
);

-- §7 : le code de version est unique et jamais réutilisé.
CREATE UNIQUE INDEX IF NOT EXISTS legal_versions_code_uidx
  ON legal_document_versions (document_type, version_code);

-- §14.1 : clé de stockage et permalien uniques et non réutilisables.
CREATE UNIQUE INDEX IF NOT EXISTS legal_versions_storage_key_uidx
  ON legal_document_versions (html_storage_key) WHERE html_storage_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS legal_versions_permalink_uidx
  ON legal_document_versions (permalink) WHERE permalink IS NOT NULL;

-- §6.1 : une seule version courante par type de document.
CREATE UNIQUE INDEX IF NOT EXISTS legal_versions_current_uidx
  ON legal_document_versions (document_type) WHERE status = 'CURRENT';

-- ── 2. Immutabilité (§3.3, §6.2 étape 7, critères 2 et 13) ─────────────────
--
-- L'interdiction ne peut pas reposer sur l'absence de route d'administration :
-- il suffirait d'un script, d'une console ou d'un futur développement pour la
-- contourner. Elle est donc posée au niveau du moteur.
--
-- Une version publiée n'accepte plus qu'une seule évolution : son statut, et
-- uniquement selon les transitions prévues au §6.1
-- (PUBLISHED ↔ CURRENT, PUBLISHED/CURRENT → ARCHIVED).

CREATE OR REPLACE FUNCTION legal_versions_guard() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'DRAFT' THEN
    -- Un brouillon reste librement modifiable (§5, §6.1).
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- Au-delà du brouillon, le contenu et l'identité sont gelés.
  IF NEW.version_code      IS DISTINCT FROM OLD.version_code
  OR NEW.document_type     IS DISTINCT FROM OLD.document_type
  OR NEW.title             IS DISTINCT FROM OLD.title
  OR NEW.change_summary    IS DISTINCT FROM OLD.change_summary
  OR NEW.html_content      IS DISTINCT FROM OLD.html_content
  OR NEW.html_storage_key  IS DISTINCT FROM OLD.html_storage_key
  OR NEW.permalink         IS DISTINCT FROM OLD.permalink
  OR NEW.sha256            IS DISTINCT FROM OLD.sha256
  OR NEW.effective_at      IS DISTINCT FROM OLD.effective_at
  OR NEW.published_at      IS DISTINCT FROM OLD.published_at
  OR NEW.published_by      IS DISTINCT FROM OLD.published_by
  OR NEW.requires_reacceptance IS DISTINCT FROM OLD.requires_reacceptance
  THEN
    RAISE EXCEPTION
      'Version % deja publiee : son contenu est fige (CDC CGVU 3.3). Creez une nouvelle version.',
      OLD.version_code
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT (
    (OLD.status = 'PUBLISHED' AND NEW.status IN ('PUBLISHED', 'CURRENT', 'ARCHIVED')) OR
    (OLD.status = 'CURRENT'   AND NEW.status IN ('CURRENT', 'ARCHIVED')) OR
    (OLD.status = 'ARCHIVED'  AND NEW.status = 'ARCHIVED')
  ) THEN
    RAISE EXCEPTION 'Transition de statut interdite : % vers %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS legal_versions_guard_trg ON legal_document_versions;
CREATE TRIGGER legal_versions_guard_trg
  BEFORE UPDATE ON legal_document_versions
  FOR EACH ROW EXECUTE FUNCTION legal_versions_guard();

-- §5 : suppression interdite dès qu'une version est publiee ou acceptee.
CREATE OR REPLACE FUNCTION legal_versions_delete_guard() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Version % publiee : suppression interdite (CDC CGVU 3.4).', OLD.version_code
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS legal_versions_delete_guard_trg ON legal_document_versions;
CREATE TRIGGER legal_versions_delete_guard_trg
  BEFORE DELETE ON legal_document_versions
  FOR EACH ROW EXECUTE FUNCTION legal_versions_delete_guard();

-- ── 3. Acceptations (§9, §14.2) ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS legal_acceptances (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   INTEGER     NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  legal_document_version_id UUID        NOT NULL REFERENCES legal_document_versions(id),
  accepted_at               TIMESTAMPTZ NOT NULL,
  acceptance_context        TEXT        NOT NULL,
  subscription_id           INTEGER     REFERENCES account_subscriptions(id) ON DELETE SET NULL,
  offer_code                TEXT,
  -- §9 : collectes uniquement si deja pratiquees a des fins de securite.
  ip_address                TEXT,
  user_agent                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT legal_acceptances_context_check CHECK (
    acceptance_context IN
      ('ACCOUNT_CREATION', 'TRIAL_START', 'PAID_SUBSCRIPTION', 'VERSION_UPDATE')
  )
);

-- ⚠️ `ON DELETE SET NULL` sur `user_id`, et non `CASCADE`.
-- §14.2 : « ne jamais supprimer les acceptations necessaires a la preuve
-- contractuelle lors de la suppression ordinaire du compte ». Un CASCADE
-- detruirait la preuve au moment ou elle devient le plus utile. La ligne
-- survit, pseudonymisee par la perte du lien nominatif.
ALTER TABLE legal_acceptances ALTER COLUMN user_id DROP NOT NULL;

-- §18 « double clic » et §14.2 : une meme action rejouee ne cree qu'une preuve.
CREATE UNIQUE INDEX IF NOT EXISTS legal_acceptances_replay_uidx
  ON legal_acceptances (
    user_id, legal_document_version_id, acceptance_context,
    COALESCE(subscription_id, -1)
  )
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS legal_acceptances_user_idx
  ON legal_acceptances (user_id, accepted_at DESC);
CREATE INDEX IF NOT EXISTS legal_acceptances_version_idx
  ON legal_acceptances (legal_document_version_id);

-- §9 : « les champs essentiels ne peuvent pas etre modifies apres creation.
-- Une correction ne se fait pas par mise a jour, mais par creation d'un
-- nouvel evenement. » Seule la pseudonymisation est autorisee.
CREATE OR REPLACE FUNCTION legal_acceptances_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.legal_document_version_id IS DISTINCT FROM OLD.legal_document_version_id
  OR NEW.accepted_at        IS DISTINCT FROM OLD.accepted_at
  OR NEW.acceptance_context IS DISTINCT FROM OLD.acceptance_context
  OR NEW.subscription_id    IS DISTINCT FROM OLD.subscription_id
  OR NEW.offer_code         IS DISTINCT FROM OLD.offer_code
  OR (OLD.user_id IS NOT NULL AND NEW.user_id IS NOT NULL
      AND NEW.user_id IS DISTINCT FROM OLD.user_id)
  THEN
    RAISE EXCEPTION
      'Acceptation % : preuve contractuelle non modifiable (CDC CGVU 9). Creez un nouvel evenement.',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS legal_acceptances_guard_trg ON legal_acceptances;
CREATE TRIGGER legal_acceptances_guard_trg
  BEFORE UPDATE ON legal_acceptances
  FOR EACH ROW EXECUTE FUNCTION legal_acceptances_guard();

-- ── 4. Journal d'audit (§19) ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS legal_audit_log (
  id            BIGSERIAL   PRIMARY KEY,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  -- 'system' lorsque l'action n'a pas d'acteur humain (controle d'integrite).
  actor_label   TEXT        NOT NULL DEFAULT 'system',
  action        TEXT        NOT NULL,
  version_code  TEXT,
  version_id    UUID,
  result        TEXT        NOT NULL DEFAULT 'success',
  details       TEXT,

  CONSTRAINT legal_audit_action_check CHECK (action IN (
    'DRAFT_CREATED', 'DRAFT_UPDATED', 'PUBLISHED', 'CURRENT_CHANGED',
    'ADMIN_DOWNLOAD', 'INTEGRITY_FAILED', 'FILE_RESTORED',
    'USER_ACCEPTED', 'CONFIRMATION_EMAIL_SENT'
  )),
  CONSTRAINT legal_audit_result_check CHECK (result IN ('success', 'failure'))
);

CREATE INDEX IF NOT EXISTS legal_audit_occurred_idx
  ON legal_audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS legal_audit_version_idx
  ON legal_audit_log (version_code);

COMMENT ON TABLE legal_document_versions IS
  'Versions de CGVU. Figees a la publication par declencheur (CDC CGVU 3.3).';
COMMENT ON TABLE legal_acceptances IS
  'Preuve contractuelle. Conservee apres suppression du compte, pseudonymisee.';
COMMENT ON TABLE legal_audit_log IS
  'Journal des operations sur les documents legaux (CDC CGVU 19).';
