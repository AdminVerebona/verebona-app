-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0212 : génération des dossiers V12 (moteur HTML/CSS + Chromium).
-- CDC Exports V12 §2.1, §15.3, §16.1, §16.2, §16.3, §18 (DRH-004/005/006),
-- §21 (LOG-001..005), IC-GEN-010.
--
-- 1. `export_generation` (table historique, conservée — MIG-05) reçoit les
--    colonnes du dictionnaire §16.2 :
--      output_format   PDF | ZIP (format livré) ;
--      file_key / file_size_bytes : fichier principal (ZIP s'il existe, sinon
--                        PDF) — les deux clés restent aussi dans
--                        output_payload pour les écrans et la suppression ;
--      expires_at      date d'expiration du téléchargement (création + 30 j) ;
--      deleted_at      suppression manuelle du fichier (DRH-004) ;
--      snapshot_json   données et choix utilisés (§16.3, IC-GEN-010) ;
--      metrics_json    durée, pages, taille, pièces, exclusions (§21) ;
--      template_version, error_code ;
--      locked_by / locked_until / next_attempt_at : file d'exécution durable
--                        (bail renouvelé, reprise après arrêt brutal).
--    Statuts : queued, generating, ready, partial, failed, expired, deleted
--    (anciennes valeurs pending/error/cancelled conservées pour l'historique).
--    Correspondance §2.1 : running = generating ; success_pdf / success_zip =
--    ready + output_format ; partial_success = partial ; file_deleted = deleted.
--
-- 2. `export_generation_items` (§16.1) : traçabilité interne des éléments
--    retenus / exclus (source, mode, statut, motif). Jamais affichée à
--    l'utilisateur (DRH-009 : l'historique ne signale pas les pièces sensibles).
--
-- 3. `export_generation_logs` (§16.1, §21) : journal technique par étape,
--    identifiants seulement — jamais le contenu des documents (LOG-001).
--
--    user_retry_count : relances manuelles (plafonnées à 3 par génération ; le
--                        compteur de tentatives n'est jamais remis à zéro).
--
-- 4. Reprise de l'existant :
--      · `error` → `failed` ;
--      · échéance des générations déjà prêtes : 30 jours À COMPTER DU
--        DÉPLOIEMENT au plus tôt (`GREATEST(…, now())`) — un fichier ancien
--        n'est pas purgé dès la première tâche quotidienne `daily-exports-
--        expiry` : l'utilisateur dispose d'un délai de grâce (DRH-005) ;
--      · `pending` (ancien moteur) : remis en file (`queued`) s'il date de
--        moins de 24 h, sinon clos en échec ; EXPORT_BRUT (synchrone) : échec ;
--      · `generating` sans bail (ancien moteur, EXPORT_BRUT interrompu par le
--        déploiement) : clos en échec — aucun worker ne le reprendrait.
--
-- Idempotente : IF NOT EXISTS partout ; UPDATE sans effet à la 2ᵉ exécution.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE export_generation
  ADD COLUMN IF NOT EXISTS output_format    text,
  ADD COLUMN IF NOT EXISTS file_key         text,
  ADD COLUMN IF NOT EXISTS file_size_bytes  bigint,
  ADD COLUMN IF NOT EXISTS expires_at       timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at       timestamptz,
  ADD COLUMN IF NOT EXISTS snapshot_json    jsonb,
  ADD COLUMN IF NOT EXISTS metrics_json     jsonb,
  ADD COLUMN IF NOT EXISTS template_version text,
  ADD COLUMN IF NOT EXISTS error_code       text,
  ADD COLUMN IF NOT EXISTS locked_by        text,
  ADD COLUMN IF NOT EXISTS locked_until     timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at  timestamptz,
  ADD COLUMN IF NOT EXISTS user_retry_count integer NOT NULL DEFAULT 0;

ALTER TABLE export_generation DROP CONSTRAINT IF EXISTS export_generation_status_check;
ALTER TABLE export_generation ADD CONSTRAINT export_generation_status_check CHECK (
  status IN ('queued', 'generating', 'ready', 'partial', 'failed', 'expired', 'deleted',
             'pending', 'error', 'cancelled')
);

ALTER TABLE export_generation DROP CONSTRAINT IF EXISTS export_generation_output_format_check;
ALTER TABLE export_generation ADD CONSTRAINT export_generation_output_format_check CHECK (
  output_format IS NULL OR output_format IN ('PDF', 'ZIP')
);

-- File d'exécution : prochaines générations à prendre (et baux expirés).
CREATE INDEX IF NOT EXISTS export_generation_queue_idx
  ON export_generation (created_at, id)
  WHERE status IN ('queued', 'generating');

-- Expiration quotidienne (DRH-005).
CREATE INDEX IF NOT EXISTS export_generation_expires_at_idx
  ON export_generation (expires_at)
  WHERE status IN ('ready', 'partial');

-- ── Reprise de l'existant ────────────────────────────────────────────────────
UPDATE export_generation SET status = 'failed' WHERE status = 'error';

UPDATE export_generation
   SET expires_at = GREATEST(COALESCE(completed_at, created_at), now()) + interval '30 days'
 WHERE expires_at IS NULL AND status IN ('ready', 'partial');

-- Demandes de l'ancien moteur jamais traitées.
UPDATE export_generation
   SET status = 'queued', next_attempt_at = NULL, locked_by = NULL, locked_until = NULL
 WHERE status = 'pending' AND export_type <> 'EXPORT_BRUT' AND created_at >= now() - interval '24 hours';

UPDATE export_generation
   SET status = 'failed', error_code = 'GENERATION_FAILED', completed_at = COALESCE(completed_at, now()),
       error_payload = '{"code":"GENERATION_FAILED","message":"La génération n''a pas pu aboutir. Relancez-la.","technicalMessage":"demande de l''ancien moteur non traitée (migration 0212)"}'
 WHERE status = 'pending';

-- Exécutions interrompues par le déploiement (aucun bail : ancien moteur ou EXPORT_BRUT).
UPDATE export_generation
   SET status = 'failed', error_code = 'GENERATION_FAILED', completed_at = COALESCE(completed_at, now()),
       error_payload = '{"code":"GENERATION_FAILED","message":"La génération n''a pas pu aboutir. Relancez-la.","technicalMessage":"exécution interrompue par le déploiement (migration 0212)"}'
 WHERE status = 'generating' AND locked_by IS NULL;

UPDATE export_generation
   SET deleted_at = COALESCE(completed_at, created_at)
 WHERE deleted_at IS NULL AND status = 'deleted';

-- ── Éléments d'une génération (§16.1) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS export_generation_items (
  id             serial      PRIMARY KEY,
  generation_id  integer     NOT NULL REFERENCES export_generation(id) ON DELETE CASCADE,
  source_type    text        NOT NULL,
  source_id      integer,
  label          text,
  mode           text,
  status         text        NOT NULL,
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT export_generation_items_mode_check CHECK (mode IS NULL OR mode IN ('PDF', 'ZIP')),
  CONSTRAINT export_generation_items_status_check CHECK (status IN ('included', 'excluded'))
);

CREATE INDEX IF NOT EXISTS export_generation_items_generation_id_idx
  ON export_generation_items (generation_id);

-- ── Journal technique (§16.1, §21) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS export_generation_logs (
  id             serial      PRIMARY KEY,
  generation_id  integer     NOT NULL REFERENCES export_generation(id) ON DELETE CASCADE,
  level          text        NOT NULL,
  step           text,
  code           text,
  message        text        NOT NULL,
  details_json   jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT export_generation_logs_level_check CHECK (level IN ('debug', 'info', 'warn', 'error'))
);

CREATE INDEX IF NOT EXISTS export_generation_logs_generation_id_idx
  ON export_generation_logs (generation_id, created_at);
