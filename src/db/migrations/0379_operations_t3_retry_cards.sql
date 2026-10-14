-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0379 : reprise automatique des erreurs T3 et des cartes « À
-- traiter » non synchronisées (lot 54D — ticket P1 Opérations V1, écarts E01
-- et E05).
--
--   document_operation_candidates
--     · t3_error_attempts : tentatives T3 en ERREUR TECHNIQUE consécutives
--       (remis à 0 par une consolidation réussie) ;
--     · t3_retry_at       : prochaine reprise automatique (backoff borné :
--       5 min × 2^(n-1), plafonné à 6 h, 6 tentatives) ; NULL = aucune
--       reprise programmée (succès, ou tentatives épuisées → BO) ;
--     · t3_last_error     : cause (code, message), job, date — diagnostic BO,
--       conservée après résolution (champ `resolvedAt`) ;
--     · t3_cards_pending  : la synchronisation des cartes « À traiter » de ce
--       document a échoué après commit — repris par le passage T3 suivant
--       (balayage horaire), sans intervention utilisateur.
--
-- Colonnes nullables / avec défaut : aucun verrou long. Index partiels dans
-- 0379_..._idx_1 et _idx_2 (CONCURRENTLY). Idempotente. Retour arrière : DROP COLUMN
-- (avec le code du lot 53 seulement : le balayage 54D lit ces colonnes).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE document_operation_candidates ADD COLUMN IF NOT EXISTS t3_error_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE document_operation_candidates ADD COLUMN IF NOT EXISTS t3_retry_at TIMESTAMPTZ;
ALTER TABLE document_operation_candidates ADD COLUMN IF NOT EXISTS t3_last_error JSONB;
ALTER TABLE document_operation_candidates ADD COLUMN IF NOT EXISTS t3_cards_pending BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN document_operation_candidates.t3_retry_at IS
  'Lot 54D (E01) : prochaine reprise automatique après une erreur technique T3 (backoff borné), NULL sinon.';
COMMENT ON COLUMN document_operation_candidates.t3_cards_pending IS
  'Lot 54D (E05) : cartes « À traiter » du document à resynchroniser (échec après commit).';
