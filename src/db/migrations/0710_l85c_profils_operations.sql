-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0710 : profils par opération et par rang (lot 85C, CDC Pilotage
-- IA V2 P4 : CFG-01, CFG-02, OP-03, R03, R35 ; décisions PO 08 et 09).
--
-- Dans la configuration versionnée EXISTANTE (aucune table, aucune version
-- parallèle) : la ligne d'un traitement `ai_config_entries` porte les profils
-- de ses opérations — raisonnement par rang, plafond de sortie par rang,
-- délai. Vide : la référence du traitement s'applique (héritage explicite).
-- Les révisions (`ai_config_revisions.snapshot`, JSON) les portent dans
-- l'instantané : aucune modification de schéma n'y est nécessaire ; les
-- révisions antérieures, sans profil, gardent leur empreinte.
-- La température n'est jamais un champ (profil technique par famille, code).
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_config_entries ADD COLUMN IF NOT EXISTS operation_profiles JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN ai_config_entries.operation_profiles IS
  'Lot 85C — profils par opération : { "<operationCode>": { reasoningByRank, maxOutputTokensByRank, timeoutMs } } (emplacements 0 principal, 1 repli 1, 2 repli 2).';
