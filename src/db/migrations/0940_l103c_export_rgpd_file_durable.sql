-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0940 — lot 103C : fiabilisation de l'export RGPD « Mes données ».
--
-- Ticket P1 « Mes données — Fiabilisation complète de l'export » (recette iOS
-- du 31/10/2026). La génération n'est plus hébergée par la requête HTTP : la
-- ligne `gdpr_exports` EST le travail durable, consommé par le worker des
-- exports (`services/exports/v12/generation/worker.ts`, même modèle que
-- `export_generation`) — prise atomique `FOR UPDATE SKIP LOCKED`, bail
-- renouvelé, tentatives et délais bornés, reprise après arrêt du processus.
--
--   gdpr_exports
--     locked_by / locked_until  bail de l'exécution en cours (battement) ;
--     next_attempt_at           nouvelle tentative différée (backoff borné) ;
--     correlation_id            identifiant de corrélation montré à
--                               l'utilisateur (« Référence ») et au support ;
--     client_request_key        clé d'idempotence du client (double clic,
--                               perte réseau après écriture) ;
--     error_code / step         code d'erreur STABLE et étape en cours ;
--     completeness              'complete' | 'partial' (archive prête) ;
--     registry_pending / registry_error
--                               dette de synchronisation du registre
--                               `gdpr_requests` (best-effort, rejouée).
--   gdpr_export_parts
--     sha256 / content_hash     intégrité de la partie et empreinte de son
--                               contenu prévu (reprise sans renvoi) ;
--     files / missing           inventaire RÉEL (fichiers présents, manques).
--
-- Additive et idempotente. Retour arrière : l'ancien code ignore ces colonnes
-- (une ligne `pending` est alors relancée par l'ancien chemin HTTP).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE gdpr_exports ADD COLUMN IF NOT EXISTS locked_by text;
ALTER TABLE gdpr_exports ADD COLUMN IF NOT EXISTS locked_until timestamptz;
ALTER TABLE gdpr_exports ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
ALTER TABLE gdpr_exports ADD COLUMN IF NOT EXISTS correlation_id text;
ALTER TABLE gdpr_exports ADD COLUMN IF NOT EXISTS client_request_key text;
ALTER TABLE gdpr_exports ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE gdpr_exports ADD COLUMN IF NOT EXISTS step text;
ALTER TABLE gdpr_exports ADD COLUMN IF NOT EXISTS completeness text;
ALTER TABLE gdpr_exports ADD COLUMN IF NOT EXISTS registry_pending boolean NOT NULL DEFAULT false;
ALTER TABLE gdpr_exports ADD COLUMN IF NOT EXISTS registry_error text;

ALTER TABLE gdpr_export_parts ADD COLUMN IF NOT EXISTS sha256 text;
ALTER TABLE gdpr_export_parts ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE gdpr_export_parts ADD COLUMN IF NOT EXISTS files jsonb;
ALTER TABLE gdpr_export_parts ADD COLUMN IF NOT EXISTS missing jsonb;

COMMENT ON COLUMN gdpr_exports.locked_until IS
  'Lot 103C : bail de la génération en cours (renouvelé) ; expiré = processus arrêté, génération reprise.';
COMMENT ON COLUMN gdpr_exports.completeness IS
  'Lot 103C : complete | partial (inventaire des manques dans summary.missing et manifest.json).';
COMMENT ON COLUMN gdpr_exports.registry_pending IS
  'Lot 103C : le registre gdpr_requests n''a pas pu être mis à jour ; rejoué par le worker et la purge quotidienne.';
