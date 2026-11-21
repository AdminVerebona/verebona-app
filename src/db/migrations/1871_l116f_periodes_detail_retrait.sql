-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1871 : périodes métier — motif PRÉCIS d'un retrait tracé (lot 116F,
-- carte Trello #812, reprise après la recette KO du 21/11/2026).
--
-- La migration 1870 trace le retrait d'une période de validité qui n'était que
-- la date du document (`superseded_reason = 'POINT_DATE_COPY'`). La règle est
-- resserrée : une validité dont le DÉBUT est la date du document et qui ne
-- porte rien d'autre est retirée même si sa mention est « propre ». Pour que
-- ces lignes restent identifiables (et restaurables si le PO le décide), une
-- colonne facultative :
--   · `superseded_detail`  motif précis du retrait : `DOCUMENT_DATE_RESTATED`
--                          (règle resserrée du 21/11), `NO_OWN_PROOF`,
--                          `PROOF_WITHOUT_DATE`, `PROOF_IS_THE_DATE`,
--                          `SAME_MENTION_AS_POINT_DATE`,
--                          `RELEVANCE_NOT_ESTABLISHED` ; NULL sinon.
--
-- Additive, idempotente, rejouable ; AUCUNE ligne modifiée ici. Le code tolère
-- l'absence de cette colonne (le retrait et son motif général ont lieu ; le
-- motif précis reste dans le journal et dans le constat du contrôle).
-- Retour arrière du schéma : DROP COLUMN superseded_detail.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE document_business_periods ADD COLUMN IF NOT EXISTS superseded_detail TEXT;

COMMENT ON COLUMN document_business_periods.superseded_detail IS
  'Carte #812 (reprise du 21/11) : motif précis d''un retrait POINT_DATE_COPY (DOCUMENT_DATE_RESTATED, NO_OWN_PROOF…). NULL sinon.';
