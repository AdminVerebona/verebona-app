-- Migration 0803 (index 1/1) : preuve de la session courante (lot 92).
-- UNE instruction par fichier (CONCURRENTLY). Idempotente.
--
-- INDEX OPTIONNEL : la table ne contient que des preuves de quelques minutes
-- (purgées chaque jour) ; sans lui, lecture séquentielle d'une petite table.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS reauth_proofs_sid_idx
  ON reauth_proofs (sid);
