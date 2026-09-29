-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0218 : faits documentaires canoniques et ciblés (+ indicateur
-- multi-biens de document_extractions) (CDC 15 T1-01,
-- T1-03, T1-04, T1-05, T4-06, PM-T1-PRE, §12 « DocumentFact : observation
-- persistante, sourcée, ciblée, avec provenance et récurrence »).
-- Colonnes ici ; index dans 0218_*_idx_*.sql.
--
--   · canonical_key       clé EXISTANTE du registre canonique, NULL pour une
--                         connaissance générique (T1-01) — `fact_key` reste la
--                         clé historique, inchangée ;
--   · raw_key / raw_value clé et valeur telles que lues, avant normalisation ;
--   · value_type          type du registre (money_eur, money_cents, date…) ;
--   · canonical_unit      unité canonique (EUR, cents, km…) — T1-03 ;
--   · target_*            cible du fait (T1-04) : type, identifiant VÉRIFIÉ
--                         en base ou NULL, libellé brut, confiance ;
--   · semantic_event_*    événement métier énoncé (type du catalogue, nature
--                         HISTORICAL | DEADLINE | FACT_ONLY) ;
--   · recurrence          récurrence ÉNONCÉE par la source (T4-06) — T1 ne
--                         calcule aucune occurrence ;
--   · projection_origin   MODEL_CANONICAL | DETERMINISTIC_RULE | GENERIC ;
--   · projection_rule     code de la règle déterministe appliquée.
--
-- NULLABLES, SANS DÉFAUT : les faits antérieurs restent sans valeur — leur en
-- inventer une serait pire. La canonicalisation des alias existants relève du
-- rattrapage MIG-01 (lot 17), pas de cette migration.
--
-- VERROUS (appliquée au démarrage) : ADD COLUMN nullable sans défaut =
-- modification de catalogue seule (aucune réécriture de table), mais sous
-- verrou ACCESS EXCLUSIVE : `lock_timeout` borne l'attente à 5 s. Dépassé : la
-- migration échoue, est signalée (/api/health) et retentée au prochain
-- démarrage ; en attendant, l'écriture des faits se replie sur les colonnes
-- historiques (contrôle `evidence/canonical-columns` côté code).
-- `SET LOCAL` : requête multi-instructions = une transaction implicite.
--
-- Idempotente : ADD COLUMN IF NOT EXISTS.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE document_facts
  ADD COLUMN IF NOT EXISTS canonical_key         TEXT,
  ADD COLUMN IF NOT EXISTS raw_key               TEXT,
  ADD COLUMN IF NOT EXISTS raw_value             TEXT,
  ADD COLUMN IF NOT EXISTS value_type            TEXT,
  ADD COLUMN IF NOT EXISTS canonical_unit        TEXT,
  ADD COLUMN IF NOT EXISTS target_type           TEXT,
  ADD COLUMN IF NOT EXISTS target_entity_id      INTEGER,
  ADD COLUMN IF NOT EXISTS target_entity_label   TEXT,
  ADD COLUMN IF NOT EXISTS target_confidence     TEXT,
  ADD COLUMN IF NOT EXISTS semantic_event_type   TEXT,
  ADD COLUMN IF NOT EXISTS semantic_event_nature TEXT,
  ADD COLUMN IF NOT EXISTS recurrence            JSONB,
  ADD COLUMN IF NOT EXISTS projection_origin     TEXT,
  ADD COLUMN IF NOT EXISTS projection_rule       TEXT;

-- Indicateur multi-biens de l'extraction (CDC 15 T1-05) : au rattachement
-- tardif d'un document, un fait ASSET sans identifiant n'est réattribué au
-- bien choisi que si le document ne concerne qu'un bien. NULL = inconnu
-- (extraction antérieure) : relu alors dans `metadata`.
ALTER TABLE document_extractions
  ADD COLUMN IF NOT EXISTS multi_asset BOOLEAN;

COMMENT ON COLUMN document_extractions.multi_asset IS
  'Document concernant plusieurs biens ou en mentionnant un autre (CDC 15 T1-05). NULL = inconnu.';

COMMENT ON COLUMN document_facts.canonical_key IS
  'Clé du registre canonique (CDC 15 T1-01) ; NULL = connaissance générique. fact_key reste la clé historique.';
COMMENT ON COLUMN document_facts.target_type IS
  'Cible du fait (CDC 15 T1-04) : ASSET | EQUIPMENT | ROOM | DOCUMENT | SUPPLIER | GENERIC.';
COMMENT ON COLUMN document_facts.target_entity_id IS
  'Identifiant de la cible VÉRIFIÉ en base pour le compte, sinon NULL (jamais un rattachement arbitraire).';
COMMENT ON COLUMN document_facts.recurrence IS
  'Récurrence énoncée par la source (CDC 15 T4-06, PM-T1-PRE) ; jamais calculée par T1.';
