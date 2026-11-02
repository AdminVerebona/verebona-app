-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0910 : site public = source juridique unique des CGUV (lot 102B).
--
-- Le texte officiel des CGUV et leurs archives sont désormais publiés par le
-- SITE PUBLIC (rubrique « Légal »). L'application ne garde que le RÉFÉRENTIEL
-- des versions (code, permalien public, empreinte SHA-256, substantielle oui /
-- non) relu dans le manifeste machine du site (`/legal/cguv/versions.json`,
-- contrat : docs/exploitation/contrat-site-public-legal.md), et les PREUVES
-- d'acceptation.
--
--   1. legal_document_versions (conservée, lecture / archives) :
--        · `source` : APP_LEGACY (versions publiées par l'ancienne mécanique,
--          HTML conservé pour l'historique), PUBLIC_SITE (importée du
--          manifeste, AUCUN texte en base), BO_MANUAL (saisie de secours dans
--          le BO, confirmée ensuite par le manifeste) ;
--        · `public_permalink`, `public_sha256` : correspondance publique d'une
--          version APP_LEGACY republiée par le site (renseignées UNE fois) ;
--        · la contrainte « version publiée complète » n'exige plus de HTML pour
--          une version publique (le texte est sur le site) ;
--        · le déclencheur d'immutabilité 0115 est inchangé : code, permalien,
--          empreinte, dates et décision `requires_reacceptance` restent figés
--          dès la publication. Garde ajoutée sur les colonnes publiques.
--   2. legal_acceptances : preuve complète, figée à la création —
--        `version_code`, `permalink_url` (URL absolue présentée), `text_sha256`,
--        `proof_status` (COMPLETE | HISTORIQUE : preuve antérieure au lot 102B,
--        empreinte JAMAIS inventée | EN_ATTENTE_SITE_PUBLIC : version connue
--        seulement par son archive applicative, le site public n'ayant pas
--        encore livré — permalien d'archive et empreinte d'origine), `channel` (WEB | IOS | ANDROID | MOBILE |
--        UNKNOWN), `subscription_reference` (abonnement Stripe concerné) ;
--        contextes ajoutés : SOCIAL_SIGNUP (connexion Google / Apple),
--        IMMEDIATE_START_REQUEST (demande expresse de démarrage immédiat
--        pendant le délai de rétractation). VERSION_UPDATE = réacceptation.
--        Seuls `subscription_id` / `subscription_reference` peuvent être
--        renseignés APRÈS coup (une fois, de NULL vers une valeur : rattachement
--        au paiement confirmé par Stripe) ; tout le reste est figé (0115).
--   3. Preuves existantes : marquées HISTORIQUE, code de version recopié depuis
--      la version rattachée ; permalien et empreinte laissés VIDES (aucune
--      valeur inventée : la version rattachée porte, elle, son empreinte).
--   4. legal_manifest_sync_state : dernier état connu de la lecture du
--      manifeste (succès, échec, empreinte, anomalies) — une ligne par document.
--   5. legal_audit_log : actions ajoutées (lecture du manifeste, import,
--      anomalie, saisie BO, réacceptation, demande de démarrage immédiat).
--
-- Additive et idempotente (IF NOT EXISTS, contraintes recréées à l'identique
-- au rejeu). Aucune donnée supprimée. Retour arrière : l'ancien code ignore les
-- nouvelles colonnes ; une version PUBLIC_SITE (sans HTML) y apparaît « contenu
-- indisponible » sur /cgvu.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

-- ── 1. Versions ───────────────────────────────────────────────────────────────
ALTER TABLE legal_document_versions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'APP_LEGACY';
ALTER TABLE legal_document_versions ADD COLUMN IF NOT EXISTS public_permalink TEXT;
ALTER TABLE legal_document_versions ADD COLUMN IF NOT EXISTS public_sha256 TEXT;
ALTER TABLE legal_document_versions ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_versions_source_check') THEN
    ALTER TABLE legal_document_versions ADD CONSTRAINT legal_versions_source_check
      CHECK (source IN ('APP_LEGACY', 'PUBLIC_SITE', 'BO_MANUAL'));
  END IF;
END $$;

-- Une version publiée porte toujours code, dates, permalien et empreinte ; le
-- HTML n'est exigé que pour l'ancienne mécanique (APP_LEGACY).
ALTER TABLE legal_document_versions DROP CONSTRAINT IF EXISTS legal_versions_published_complete_check;
ALTER TABLE legal_document_versions ADD CONSTRAINT legal_versions_published_complete_check CHECK (
  status = 'DRAFT' OR (
    published_at IS NOT NULL AND effective_at IS NOT NULL AND
    sha256 IS NOT NULL AND permalink IS NOT NULL AND (
      source <> 'APP_LEGACY' OR (html_content IS NOT NULL AND html_storage_key IS NOT NULL)
    )
  )
);

-- Correspondance publique d'une version : renseignée une fois, jamais changée.
CREATE OR REPLACE FUNCTION legal_versions_public_guard() RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.public_permalink IS NOT NULL AND NEW.public_permalink IS DISTINCT FROM OLD.public_permalink)
  OR (OLD.public_sha256 IS NOT NULL AND NEW.public_sha256 IS DISTINCT FROM OLD.public_sha256)
  OR (OLD.status <> 'DRAFT' AND NEW.source IS DISTINCT FROM OLD.source) THEN
    RAISE EXCEPTION
      'Version % : correspondance publique figee (lot 102B). Publiez une nouvelle version.',
      OLD.version_code
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS legal_versions_public_guard_trg ON legal_document_versions;
CREATE TRIGGER legal_versions_public_guard_trg
  BEFORE UPDATE ON legal_document_versions
  FOR EACH ROW EXECUTE FUNCTION legal_versions_public_guard();

-- ── 2. Preuves d'acceptation ─────────────────────────────────────────────────
ALTER TABLE legal_acceptances ADD COLUMN IF NOT EXISTS version_code TEXT;
ALTER TABLE legal_acceptances ADD COLUMN IF NOT EXISTS permalink_url TEXT;
ALTER TABLE legal_acceptances ADD COLUMN IF NOT EXISTS text_sha256 TEXT;
ALTER TABLE legal_acceptances ADD COLUMN IF NOT EXISTS proof_status TEXT NOT NULL DEFAULT 'COMPLETE';
ALTER TABLE legal_acceptances ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE legal_acceptances ADD COLUMN IF NOT EXISTS subscription_reference TEXT;

ALTER TABLE legal_acceptances DROP CONSTRAINT IF EXISTS legal_acceptances_context_check;
ALTER TABLE legal_acceptances ADD CONSTRAINT legal_acceptances_context_check CHECK (
  acceptance_context IN (
    'ACCOUNT_CREATION', 'SOCIAL_SIGNUP', 'TRIAL_START', 'PAID_SUBSCRIPTION',
    'VERSION_UPDATE', 'IMMEDIATE_START_REQUEST'
  )
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_acceptances_channel_check') THEN
    ALTER TABLE legal_acceptances ADD CONSTRAINT legal_acceptances_channel_check
      CHECK (channel IN ('WEB', 'IOS', 'ANDROID', 'MOBILE', 'UNKNOWN'));
  END IF;
END $$;

ALTER TABLE legal_acceptances DROP CONSTRAINT IF EXISTS legal_acceptances_proof_status_check;
ALTER TABLE legal_acceptances ADD CONSTRAINT legal_acceptances_proof_status_check
  CHECK (proof_status IN ('COMPLETE', 'HISTORIQUE', 'EN_ATTENTE_SITE_PUBLIC'));

-- 3. Preuves antérieures : HISTORIQUE, code recopié, rien d'inventé. Le
--    déclencheur 0115 n'interdit pas ces colonnes (non listées) ; la garde
--    ci-dessous les fige ensuite.
UPDATE legal_acceptances la
   SET proof_status = 'HISTORIQUE',
       version_code = v.version_code
  FROM legal_document_versions v
 WHERE v.id = la.legal_document_version_id
   AND la.version_code IS NULL;

-- Garde 0115 étendue : preuve figée, sauf rattachement unique à l'abonnement
-- (NULL → valeur) et pseudonymisation (user_id, ip, agent → NULL).
CREATE OR REPLACE FUNCTION legal_acceptances_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.legal_document_version_id IS DISTINCT FROM OLD.legal_document_version_id
  OR NEW.accepted_at        IS DISTINCT FROM OLD.accepted_at
  OR NEW.acceptance_context IS DISTINCT FROM OLD.acceptance_context
  OR (OLD.subscription_id IS NOT NULL AND NEW.subscription_id IS DISTINCT FROM OLD.subscription_id)
  OR (OLD.subscription_reference IS NOT NULL AND NEW.subscription_reference IS DISTINCT FROM OLD.subscription_reference)
  OR NEW.offer_code         IS DISTINCT FROM OLD.offer_code
  OR (OLD.version_code IS NOT NULL AND NEW.version_code IS DISTINCT FROM OLD.version_code)
  OR NEW.permalink_url      IS DISTINCT FROM OLD.permalink_url
  OR NEW.text_sha256        IS DISTINCT FROM OLD.text_sha256
  OR NEW.channel            IS DISTINCT FROM OLD.channel
  -- Statut figé, sauf reclassement HISTORIQUE d'une preuve antérieure (code absent).
  OR (NEW.proof_status IS DISTINCT FROM OLD.proof_status
      AND NOT (OLD.version_code IS NULL AND NEW.proof_status = 'HISTORIQUE'))
  OR (OLD.user_id IS NOT NULL AND NEW.user_id IS NOT NULL
      AND NEW.user_id IS DISTINCT FROM OLD.user_id)
  THEN
    RAISE EXCEPTION
      'Acceptation % : preuve contractuelle non modifiable (CDC CGUV 9). Creez un nouvel evenement.',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE INDEX IF NOT EXISTS legal_acceptances_immediate_start_idx
  ON legal_acceptances (user_id, accepted_at DESC)
  WHERE acceptance_context = 'IMMEDIATE_START_REQUEST' AND subscription_reference IS NULL;

-- ── 4. Dernier état connu du manifeste public ────────────────────────────────
CREATE TABLE IF NOT EXISTS legal_manifest_sync_state (
  document_type         TEXT        PRIMARY KEY,
  manifest_url          TEXT,
  last_attempt_at       TIMESTAMPTZ,
  last_success_at       TIMESTAMPTZ,
  last_status           TEXT        NOT NULL DEFAULT 'never',
  last_error            TEXT,
  consecutive_failures  INTEGER     NOT NULL DEFAULT 0,
  manifest_sha256       TEXT,
  current_version_code  TEXT,
  versions_count        INTEGER     NOT NULL DEFAULT 0,
  anomalies             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  last_trigger          TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT legal_manifest_sync_status_check
    CHECK (last_status IN ('never', 'ok', 'ok_with_anomalies', 'unavailable', 'invalid', 'awaiting_public_site')),
  CONSTRAINT legal_manifest_sync_anomalies_array CHECK (jsonb_typeof(anomalies) = 'array')
);

-- Contrainte recréée à l'identique au rejeu (valeurs ajoutées sans perte).
ALTER TABLE legal_manifest_sync_state DROP CONSTRAINT IF EXISTS legal_manifest_sync_status_check;
ALTER TABLE legal_manifest_sync_state ADD CONSTRAINT legal_manifest_sync_status_check
  CHECK (last_status IN ('never', 'ok', 'ok_with_anomalies', 'unavailable', 'invalid', 'awaiting_public_site'));

-- ── 5. Journal ───────────────────────────────────────────────────────────────
ALTER TABLE legal_audit_log DROP CONSTRAINT IF EXISTS legal_audit_action_check;
ALTER TABLE legal_audit_log ADD CONSTRAINT legal_audit_action_check CHECK (action IN (
  'DRAFT_CREATED', 'DRAFT_UPDATED', 'PUBLISHED', 'CURRENT_CHANGED',
  'ADMIN_DOWNLOAD', 'INTEGRITY_FAILED', 'FILE_RESTORED',
  'USER_ACCEPTED', 'CONFIRMATION_EMAIL_SENT',
  'MANIFEST_SYNCED', 'MANIFEST_SYNC_FAILED', 'MANIFEST_ANOMALY',
  'VERSION_IMPORTED', 'VERSION_MANUAL_ENTRY', 'IMMEDIATE_START_REQUESTED'
));

COMMENT ON TABLE legal_manifest_sync_state IS
  'Dernier etat connu du manifeste public des CGUV (lot 102B). Aucun texte juridique.';
COMMENT ON COLUMN legal_document_versions.html_content IS
  'Archive des versions APP_LEGACY (avant lot 102B). Plus jamais servie comme source : le site public fait foi.';
