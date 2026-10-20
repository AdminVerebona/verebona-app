-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0513 : T3 — fiabilisation de l'harmonisation documentaire (lot 72B,
-- ticket « [P1] T3 — Fiabiliser l'harmonisation documentaire et corriger les
-- écarts du lot 61 », E1 à E9).
--
--   document_naming_members (E1, E4) — INDEX PERSISTANT des documents
--       éligibles du compte, alimenté page après page par un curseur
--       persistant (progression dans la ligne d'état « * » du compte) :
--       `doc_hash` = empreinte du document (nom, protection, données utiles à
--       l'IA : faits, texte, période, contrats, relations, classement) ;
--       `link_keys` = clés de rapprochement GÉNÉRIQUES (émetteur normalisé,
--       SIRET, référence de contrat, Opération partagée ; nature + bien à
--       défaut). Les lots de comparaison sont recalculés sur l'index complet :
--       une famille dont les membres sont lus sur des pages ou des passages
--       différents est examinée ensemble ; aucun plafond de lecture.
--       Aucune nomenclature : seules des clés techniques y figurent.
--
--   document_naming_groups
--       status + WRITE_PENDING (E6) : examen IA terminé, écritures à
--       reprendre (sans nouvel appel IA tant que le contexte est inchangé) ;
--       context_version : version du contexte ayant produit `fingerprint`
--       (passage du lot 61 au lot 72 sans réexamen IA si rien n'a changé).
--
--   document_rename_events (E6, E8)
--       call_key, validated_name : décision acceptée par les garde-fous dont
--       l'écriture a échoué — rejouable telle quelle (même clé
--       d'idempotence : jamais de doublon) ;
--       retry_status : PENDING | RESOLVED | CONFLICT | SUPERSEDED | ABANDONED ;
--       retry_attempts, retried_at ; retry_of : sur un APPLIED issu d'une
--       reprise, l'échec d'origine (corrélation du reporting).
--
-- Colonnes NULLables ou à défaut constant (instantané), table neuve vide.
-- Idempotente, rejouable. Index annexe : 0513_..._idx_1 (CONCURRENTLY).
-- Retour arrière : le code du lot 71 ignore table et colonnes ; la contrainte
-- de statut élargie reste compatible (WRITE_PENDING jamais écrit par lui).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_naming_members (
  account_id   INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id      INTEGER     NOT NULL,
  link_keys    TEXT[]      NOT NULL DEFAULT '{}',
  doc_hash     TEXT        NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_naming_members_pk PRIMARY KEY (account_id, file_id)
);

COMMENT ON TABLE document_naming_members IS
  'Lot 72B : index persistant des documents éligibles à l''harmonisation T3 (empreinte du contexte, clés de rapprochement génériques) — lecture exhaustive à curseur persistant, sans plafond.';

ALTER TABLE document_naming_groups ADD COLUMN IF NOT EXISTS context_version TEXT;

ALTER TABLE document_naming_groups DROP CONSTRAINT IF EXISTS document_naming_groups_status_check;
ALTER TABLE document_naming_groups ADD CONSTRAINT document_naming_groups_status_check
  CHECK (status IN ('DONE', 'IN_PROGRESS', 'DEFERRED', 'ERROR', 'PROMPT_UNAVAILABLE', 'WRITE_PENDING'));

ALTER TABLE document_rename_events ADD COLUMN IF NOT EXISTS call_key        TEXT;
ALTER TABLE document_rename_events ADD COLUMN IF NOT EXISTS validated_name  TEXT;
ALTER TABLE document_rename_events ADD COLUMN IF NOT EXISTS retry_status    TEXT;
ALTER TABLE document_rename_events ADD COLUMN IF NOT EXISTS retry_attempts  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE document_rename_events ADD COLUMN IF NOT EXISTS retried_at      TIMESTAMPTZ;
ALTER TABLE document_rename_events ADD COLUMN IF NOT EXISTS retry_of        BIGINT;

ALTER TABLE document_rename_events DROP CONSTRAINT IF EXISTS document_rename_events_retry_status_check;
ALTER TABLE document_rename_events ADD CONSTRAINT document_rename_events_retry_status_check
  CHECK (retry_status IS NULL OR retry_status IN ('PENDING', 'RESOLVED', 'CONFLICT', 'SUPERSEDED', 'ABANDONED')) NOT VALID;
