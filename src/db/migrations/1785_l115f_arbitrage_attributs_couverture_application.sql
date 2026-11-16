-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1785 : événements de référence — arbitrage T3 d'une contradiction
-- d'attribut (lot 115, carte Trello #791, écarts E02, E07 et E09 ; suite de la
-- migration 1690 du lot 114, carte #750).
--
-- Trois manques comblés sur `business_operation_attribute_arbitrations` :
--
--   · E02 — COUVERTURE DES PREUVES. Un verdict « faits distincts »,
--     « indécidable » ou « document étranger » pouvait être rendu CERTAIN sur
--     un contexte tronqué (au-delà de 4 valeurs ou 6 documents, ou avec une
--     pièce non chargée) : la couverture n'était contrôlée que pour une valeur
--     retenue. Nouvel état `INCOMPLETE` : la demande est close sans aucun appel
--     à l'IA, le diagnostic est MAINTENU et la carte « À traiter » est posée.
--
--   · E07 — PÉRIMÈTRE MATÉRIEL DES PREUVES (`evidence_key`). L'empreinte d'un
--     constat ne portait que l'attribut, le rôle et les valeurs normalisées :
--     une pièce nouvelle qui change l'autorité, la révision déclarée,
--     l'identité ou la date d'effet — sans changer la chaîne des valeurs —
--     n'entraînait aucun réexamen. La clé matérielle (`evidenceScopeKeyOf`,
--     `attribute-conflicts.ts`) ignore délibérément l'identifiant du document
--     et l'horodatage : vingt scans identiques ou une pièce ÉQUIVALENTE
--     redéposée ne relancent rien.
--
--   · E09 — APPLICATION VÉRIFIÉE. « Décidé » n'est plus « appliqué » :
--     `application_state` sépare la décision REÇUE, l'application EN COURS,
--     l'application VÉRIFIÉE et l'ÉCHEC repris au passage suivant. Une panne
--     entre la décision et la reconsolidation laisse une ligne RECEIVED /
--     APPLYING, reprise (idempotente) par le passage T3 suivant.
--
-- Additive, idempotente, rejouable ; aucune reprise de données (les lignes
-- existantes gardent `evidence_key` et `application_state` nuls : elles sont
-- lues « périmètre inconnu, toléré » et « application non vérifiée »).
-- Retour arrière : les colonnes restent, le code les ignore.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE business_operation_attribute_arbitrations
  ADD COLUMN IF NOT EXISTS evidence_key         TEXT,
  ADD COLUMN IF NOT EXISTS application_state    TEXT,
  ADD COLUMN IF NOT EXISTS application_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS application_error    TEXT;

COMMENT ON COLUMN business_operation_attribute_arbitrations.evidence_key IS
  'Lot 115 (#791, E07) : périmètre MATÉRIEL des preuves soumises (rôle, autorité, relation déclarée, références, bornes d''effet) — ni identifiant de document, ni horodatage. NULL : examen antérieur au lot 115 (toléré).';
COMMENT ON COLUMN business_operation_attribute_arbitrations.application_state IS
  'Lot 115 (#791, E09) : RECEIVED (décision reçue), APPLYING (application en cours), APPLIED (application VÉRIFIÉE sur l''événement), APPLY_FAILED (valeur protégée ou saisie non gérée, repris). NULL : décision sans effet à appliquer.';

DO $$
BEGIN
  -- E02 : état INCOMPLETE (couverture des preuves non prouvée, aucun appel IA).
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_attribute_arbitrations_status_chk') THEN
    ALTER TABLE business_operation_attribute_arbitrations DROP CONSTRAINT business_operation_attribute_arbitrations_status_chk;
  END IF;
  ALTER TABLE business_operation_attribute_arbitrations ADD CONSTRAINT business_operation_attribute_arbitrations_status_chk
    CHECK (status IN ('PENDING', 'DECIDED', 'ABSTAINED', 'REJECTED', 'NOT_CERTAIN', 'AI_FAILED', 'OBSOLETE', 'UNAVAILABLE', 'INCOMPLETE'));

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_attribute_arbitrations_application_chk') THEN
    ALTER TABLE business_operation_attribute_arbitrations ADD CONSTRAINT business_operation_attribute_arbitrations_application_chk
      CHECK (application_state IS NULL OR application_state IN ('RECEIVED', 'APPLYING', 'APPLIED', 'APPLY_FAILED'));
  END IF;
END $$;

-- E09 : reprise des applications inachevées d'un compte (décidé, jamais vérifié).
CREATE INDEX IF NOT EXISTS business_operation_attribute_arbitrations_apply_idx
  ON business_operation_attribute_arbitrations (account_id, id)
  WHERE application_state IN ('RECEIVED', 'APPLYING', 'APPLY_FAILED');
