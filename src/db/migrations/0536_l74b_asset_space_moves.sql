-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0536 : journal des déplacements volontaires d'un bien vers
-- l'espace Duo (lot 74B, point 4 — réponse PO à la question Q1 du lot 72D).
--
-- Un utilisateur membre ACTIF de deux espaces (son espace personnel et un
-- Premium Duo) déplace un de ses biens, avec tout ce qui s'y rattache, vers
-- l'espace Duo (`asset-space-move.service.ts`, même règle de transfert que le
-- lot 40 : `transferAssetDataInTx`).
--
-- Une ligne par déplacement EFFECTIF (jamais pour un aperçu ni un refus) :
--   · bien, compte de départ, compte d'arrivée, auteur, nom du bien figé ;
--   · `fingerprint` : empreinte de ce que la confirmation affichait ;
--   · `report` : rapport complet (documents déplacés / restés, agenda,
--     Opérations, « À traiter », fournisseurs, lignes déplacées par table,
--     quotas du compte cible après déplacement).
-- Sert aussi de PREUVE d'un déplacement légitime au rattrapage automatique
-- `asset-account-backfill` (lot 40/54) et d'idempotence (rejeu).
--
-- Pas de colonne `account_id` : la table n'appartient à aucun des deux
-- comptes (contrôle d'isolation des comptes et purge par compte non
-- concernés) ; les clés étrangères passent à NULL à la suppression d'un
-- compte, d'un bien ou d'un utilisateur — le nom figé reste lisible.
--
-- Idempotente (IF NOT EXISTS). Table neuve et vide : index créés ici, sans
-- CONCURRENTLY (aucune table existante verrouillée).
-- Retour arrière : table ignorée par l'ancien code.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS asset_space_moves (
  id               bigserial PRIMARY KEY,
  asset_id         integer REFERENCES assets(id) ON DELETE SET NULL,
  asset_name       text NOT NULL,
  from_account_id  integer REFERENCES accounts(id) ON DELETE SET NULL,
  to_account_id    integer REFERENCES accounts(id) ON DELETE SET NULL,
  user_id          integer REFERENCES users(id) ON DELETE SET NULL,
  fingerprint      text,
  report           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS asset_space_moves_asset_idx ON asset_space_moves (asset_id, to_account_id);
CREATE INDEX IF NOT EXISTS asset_space_moves_created_idx ON asset_space_moves (created_at DESC);
