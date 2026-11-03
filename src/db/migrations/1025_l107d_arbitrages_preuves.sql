-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1025 : mémoire des arbitrages « À traiter » par CONTENU des preuves
-- (lot 107D, ticket P1 « Draisienne : total du ticket proposé comme prix d'un
-- article, carte réapparue alors que l'utilisateur avait déjà répondu »).
--
--   to_process_actions.evidence_keys  JSONB — clés de CONTENU des preuves qui
--       justifient les propositions de la carte (document source, champ
--       canonique, valeur normalisée, cible), INDÉPENDANTES des identifiants
--       `field_evidence.id` : une réanalyse T1, une reprojection ou une
--       rematérialisation recréent des lignes de preuve (nouvel identifiant)
--       sans apporter d'élément nouveau. Une carte tranchée par l'utilisateur
--       garde les clés examinées ; un nouvel arbitrage du même champ n'est
--       ouvert que sur une preuve INDÉPENDANTE (autre document), fiable et
--       ciblée (`services/to-process/arbitration-memory.ts`).
--   to_process_actions.reopen_reason  JSONB — motif EXPLIQUÉ d'une nouvelle
--       carte ouverte après une décision de l'utilisateur : carte tranchée
--       précédente, nouvelles sources (document, valeur), code stable.
--
-- Colonnes nullables, sans défaut : ajout instantané, aucune réécriture de
-- table. Les cartes existantes (NULL) sont relues par recalcul depuis leurs
-- `proposals_json.evidenceIds` (les preuves ne sont jamais supprimées).
-- Additive et idempotente, rejouable. Retour arrière : l'ancien code ignore
-- ces colonnes (ALTER TABLE … DROP COLUMN IF EXISTS possible, aucune
-- dépendance).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE to_process_actions ADD COLUMN IF NOT EXISTS evidence_keys JSONB;
ALTER TABLE to_process_actions ADD COLUMN IF NOT EXISTS reopen_reason JSONB;

COMMENT ON COLUMN to_process_actions.evidence_keys IS
  'Lot 107D : clés de contenu des preuves des propositions (source, champ, valeur normalisée, cible) — indépendantes des identifiants de preuve.';
COMMENT ON COLUMN to_process_actions.reopen_reason IS
  'Lot 107D : motif expliqué d''un nouvel arbitrage ouvert après une décision de l''utilisateur (nouvelle preuve indépendante).';
