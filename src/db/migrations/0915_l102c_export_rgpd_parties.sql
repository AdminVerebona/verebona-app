-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0915 — lot 102C : export RGPD « Mes données » en PARTIES numérotées.
--
-- Ticket conformité légale, P2 « Export RGPD dans les états restreints » :
-- un utilisateur en lecture seule (fin d'essai, fin d'abonnement,
-- rétractation) ou en suppression demandée doit récupérer TOUS ses
-- originaux, sans ZIP unique illimité. L'archive est désormais découpée en
-- parties de taille bornée (GDPR_EXPORT_PART_MAX_BYTES) :
--   · partie 1 : données (JSON), manifeste global, LISEZ-MOI et premiers
--     documents ;
--   · parties 2..N : documents seulement, chacune avec son propre manifeste.
-- Chaque partie se télécharge par un lien signé de courte durée.
--
--   1. gdpr_export_parts : une ligne par partie (clé de stockage, taille,
--      documents). Supprimée avec l'export (CASCADE) — donc avec
--      l'utilisateur ; les objets sont confiés à la file de purge.
--   2. gdpr_exports.parts_count : nombre de parties (NULL = ancien export,
--      une seule archive `s3_key`) ;
--      gdpr_exports.progress_at : dernière progression (une génération
--      longue n'est plus considérée comme interrompue tant qu'elle avance).
--
-- Additive et idempotente. Retour arrière : l'ancien code lit `s3_key`
-- (= partie 1) et ignore le reste.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE gdpr_exports ADD COLUMN IF NOT EXISTS parts_count integer;
ALTER TABLE gdpr_exports ADD COLUMN IF NOT EXISTS progress_at timestamptz;

CREATE TABLE IF NOT EXISTS gdpr_export_parts (
  id bigserial PRIMARY KEY,
  export_id integer NOT NULL REFERENCES gdpr_exports(id) ON DELETE CASCADE,
  part_number integer NOT NULL,
  s3_key text,
  size_bytes bigint,
  document_count integer NOT NULL DEFAULT 0,
  missing_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gdpr_export_parts_number_check CHECK (part_number >= 1),
  CONSTRAINT gdpr_export_parts_key UNIQUE (export_id, part_number)
);

COMMENT ON TABLE gdpr_export_parts IS
  'Lot 102C : parties numérotées de l''archive « Mes données » (taille bornée, lien signé court par partie).';
