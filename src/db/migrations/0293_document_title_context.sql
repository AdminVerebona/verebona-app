-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0293 : moteur de titre v2 — version des règles et empreinte du
-- contexte du titre (lot 34E, ticket « Documents : refondre le moteur de titre
-- et assurer la repasse T3 sur l'existant »).
--
-- 1. asset_files.title_rule_version        version des règles de titre
--    (`DOCUMENT_TITLE_RULE_VERSION`) lors du dernier contrôle. NULL ou
--    inférieure à la version du code → le titre SYSTEM est repris par le
--    balayage T3 `document_title_sweep` (rattrapage de TOUT l'existant, y
--    compris les titres jusque-là jugés valides, sans script).
-- 2. asset_files.title_context_fingerprint empreinte des SEULES données utiles
--    au titre (nature, sujet, fournisseur, période, cible bien / équipement /
--    pièce, référence, doublon). Même version + même empreinte → aucun
--    retraitement ; contexte modifié → titre réévaluable.
-- 3. document_title_events — observabilité étendue : version des règles,
--    empreinte du contexte, motif de déclenchement (RULE_VERSION_UPGRADE,
--    CONTEXT_CHANGED, NEW_ANALYSIS) ; nouvelles issues NO_CHANGE et
--    INSUFFICIENT_DATA (les anciennes restent admises pour l'historique).
--
-- Rattrapage : aucun SQL ici — `title_rule_version` NULL sur tout l'existant ;
-- le balayage horaire T3 reprend progressivement les titres SYSTEM (pages
-- bornées, reprenables, idempotentes ; jamais un titre USER).
--
-- VERROUS : ADD COLUMN nullables sans défaut (métadonnées) ; contrainte
-- remplacée NOT VALID puis VALIDATE (SHARE UPDATE EXCLUSIVE, n'empêche pas les
-- écritures). Idempotente.
-- Retour arrière : les colonnes peuvent rester (l'ancien code les ignore) ;
-- l'ancienne contrainte d'issue n'admettait pas NO_CHANGE / INSUFFICIENT_DATA.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS title_rule_version INTEGER;
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS title_context_fingerprint TEXT;

COMMENT ON COLUMN asset_files.title_rule_version IS
  'Version des règles de titre lors du dernier contrôle (NULL / ancienne : titre SYSTEM à reprendre par T3).';
COMMENT ON COLUMN asset_files.title_context_fingerprint IS
  'Empreinte des données utiles au titre lors du dernier contrôle (contexte inchangé : aucun retraitement).';

ALTER TABLE document_title_events ADD COLUMN IF NOT EXISTS rule_version INTEGER;
ALTER TABLE document_title_events ADD COLUMN IF NOT EXISTS context_fingerprint TEXT;
ALTER TABLE document_title_events ADD COLUMN IF NOT EXISTS trigger_reason TEXT;

ALTER TABLE document_title_events DROP CONSTRAINT IF EXISTS document_title_events_outcome_check;
ALTER TABLE document_title_events ADD CONSTRAINT document_title_events_outcome_check
  CHECK (outcome IN ('UPDATED', 'NO_CHANGE', 'SKIP_USER_TITLE', 'INSUFFICIENT_DATA', 'FAILED',
                     'SKIP_VALID_TITLE', 'SKIP_INSUFFICIENT_DATA')) NOT VALID;
ALTER TABLE document_title_events VALIDATE CONSTRAINT document_title_events_outcome_check;
