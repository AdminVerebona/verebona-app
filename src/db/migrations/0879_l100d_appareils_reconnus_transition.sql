-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0879 : transition des appareils reconnus, détachée de l'historique
-- des adresses (lot 100D — décision PO A3 du 27/10/2026 ; CDC 18 §20.4, Q8).
--
-- Contexte : depuis l'intégration 96, un appareil reconnu (cookie signé
-- `vb_device`) est lié à l'IDENTIFIANT STABLE du compte. Seules les entrées
-- HÉRITÉES (émises avant l'intégration, liées à l'adresse, 180 jours au plus)
-- ont encore besoin de l'adresse D'ORIGINE du compte ; elle était lue dans la
-- plus ancienne demande de changement d'adresse confirmée, ce qui obligeait à
-- conserver ces demandes 180 jours.
--
-- Désormais : avant de supprimer une demande confirmée (purge à 30 jours,
-- `purgeEmailChangeRequests`), l'application garde ICI, pour ce compte,
-- l'ÉTIQUETTE (HMAC, 16 caractères — même étiquette que dans le cookie) de
-- son adresse d'origine. Ni adresse en clair, ni jeton. La ligne expire
-- 180 jours après sa création (durée maximale d'une entrée héritée) et est
-- alors supprimée par la même purge.
--
-- Aucune reprise de données à faire au déploiement : les demandes confirmées
-- existantes sont toutes encore en base (conservées 180 jours jusqu'ici) ;
-- l'étiquette est prise au moment de leur purge. Aucun appareil déjà connu ne
-- devient « nouveau ».
--
-- Supprimée avec l'utilisateur (ON DELETE CASCADE). Jamais exportée ; une
-- restauration ne la modifie pas (sécurité).
-- Additive et idempotente. Table neuve, clé primaire seule (aucun index à
-- créer en CONCURRENTLY).
-- Retour arrière : DROP TABLE IF EXISTS device_trust_legacy_accounts.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS device_trust_legacy_accounts (
  user_id     INTEGER     PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  legacy_tag  TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
