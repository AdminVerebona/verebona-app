-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0945 : preuve de réalisation d'un FAIT HISTORIQUE de l'agenda
-- (lot 103D, ticket « Agenda — statut et rappels », cas « Contrôle réalisé —
-- Maison » du 22/12/2020).
--
--   · agenda_items.completion_proof_file_id  document LIÉ qui prouve la
--       réalisation (daté du jour du fait, type documentaire établissant la
--       réalisation — règle `historicalCompletionVerdict`). Posé par le
--       contrôle de cohérence COH-AGENDA-HISTORICAL-STATUS, jamais par
--       l'intitulé ni par la seule date dépassée ;
--   · agenda_items.completion_proven_at       instant de la qualification.
--
-- Le statut affiché devient « Réalisé » À LA LECTURE (`computeEffectiveStatus`)
-- tant que le document existe dans le compte et n'est pas supprimé — SANS poser
-- de statut manuel : l'élément reste automatique et intact (T4 peut le mettre à
-- jour, la consolidation 76H peut encore fusionner deux représentations de la
-- même occurrence). Un statut posé par l'utilisateur prime toujours.
--
-- Colonnes nullables sans défaut ni clé étrangère (aucune réécriture de table,
-- aucun verrou long ; le document est revérifié à la lecture : compte, non
-- supprimé). Additive et idempotente.
-- Retour arrière : ALTER TABLE agenda_items DROP COLUMN IF EXISTS
-- completion_proof_file_id, DROP COLUMN IF EXISTS completion_proven_at (les
-- faits concernés redeviennent « Statut à confirmer »).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS completion_proof_file_id INTEGER;
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS completion_proven_at TIMESTAMPTZ;

COMMENT ON COLUMN agenda_items.completion_proof_file_id IS
  'Lot 103D : document lié prouvant la réalisation d''un fait historique (contrôle COH-AGENDA-HISTORICAL-STATUS) — statut « Réalisé » calculé à la lecture, sans statut manuel.';
COMMENT ON COLUMN agenda_items.completion_proven_at IS
  'Lot 103D : instant de la qualification « réalisation prouvée ».';
