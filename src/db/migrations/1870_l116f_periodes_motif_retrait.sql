-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1870 : périodes métier — MOTIF et corrélation d'un retrait (lot 116F,
-- carte Trello #812 « Supprimer les périodes de validité artificielles »).
--
-- Une période de validité dont la seule borne est une date ponctuelle du
-- document (commande, facture, émission…) n'est plus qualifiée. Les périodes
-- déjà enregistrées de cette sorte sont RETIRÉES par le contrôle de cohérence
-- COH-DOC-BUSINESS-PERIODS (statut SUPERSEDED — jamais supprimées). Pour que
-- ce retrait soit traçable et réversible, deux colonnes facultatives :
--   · `superseded_reason`         motif du retrait (`POINT_DATE_COPY`) ; NULL
--                                 pour tous les retraits ordinaires (période
--                                 requalifiée, corrigée par l'utilisateur) ;
--   · `superseded_correlation_id` corrélation de l'exécution qui a retiré la
--                                 période (campagne de cohérence, analyse).
--
-- Additive, idempotente, rejouable ; AUCUNE reprise de données ici (aucune
-- ligne modifiée) : le stock est traité par le contrôle de cohérence, à blanc
-- d'abord. Le code tolère l'absence de ces colonnes (le retrait a lieu, la
-- trace reste dans le journal du contrôle de cohérence).
-- Retour arrière des données :
--   UPDATE document_business_periods SET status = 'ACTIVE', superseded_at = NULL
--    WHERE superseded_reason = 'POINT_DATE_COPY' AND <périmètre> ;
--   (à faire avec le contrôle COH-DOC-BUSINESS-PERIODS coupé, sinon il les retire à nouveau).
-- Retour arrière du schéma : DROP COLUMN superseded_reason, superseded_correlation_id.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE document_business_periods ADD COLUMN IF NOT EXISTS superseded_reason TEXT;
ALTER TABLE document_business_periods ADD COLUMN IF NOT EXISTS superseded_correlation_id TEXT;

-- Rapport « avant / après » de la reprise : périodes retirées par motif (index partiel, très peu de lignes).
CREATE INDEX IF NOT EXISTS document_business_periods_superseded_reason_idx
  ON document_business_periods (account_id, superseded_reason) WHERE superseded_reason IS NOT NULL;

COMMENT ON COLUMN document_business_periods.superseded_reason IS
  'Carte #812 : motif d''un retrait tracé (POINT_DATE_COPY : la période n''était que la date du document). NULL : retrait ordinaire.';
