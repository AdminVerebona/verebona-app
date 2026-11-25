-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1960 : événements de référence — APPLICATION VÉRIFIÉE d'un arbitrage
-- T3 d'attribut, et ESCALADE de son épuisement (carte Trello #836, écart E09 ;
-- suite des migrations 1690 du lot 114, carte #750, et 1785 du lot 115F,
-- carte #791).
--
-- Un seul manque comblé, sur `business_operation_attribute_arbitrations` :
--
--   · E09 — ÉPUISEMENT DU PLAFOND DE REPRISES. La migration 1785 a créé les
--     états d'application (`RECEIVED` → `APPLYING` → `APPLIED`, et
--     `APPLY_FAILED` repris), et le code borne les reprises
--     (`ATTRIBUTE_ARBITRATION_MAX_ATTEMPTS`). Mais rien ne disait ce que
--     devient une décision dont le plafond est ATTEINT : la ligne sortait
--     silencieusement de la file de reprise, sans état, sans trace et sans
--     personne pour s'en apercevoir — un faux « résolu » remplacé par un
--     blocage muet. Nouvel état `ESCALATED` : la décision est déclarée NON
--     APPLIQUÉE pour de bon, la contradiction redevient visible et actionnable
--     (carte « À traiter », motif `T3_APPLICATION_ESCALATED`, diagnostic BO), et
--     l'escalade est tracée (`application_error`, `validation.
--     applicationEscalated`, journal du passage T3).
--
-- Aucune colonne nouvelle : seule la contrainte de contrôle des états
-- d'application est étendue, et l'index de reprise est complété pour que les
-- lignes escaladées restent lisibles sans balayage.
--
-- Additive, idempotente, rejouable, NON DESTRUCTIVE ; aucune reprise de données
-- (les lignes existantes gardent leur état ; `ESCALATED` n'est posé que par le
-- passage T3, sur une décision dont les reprises sont réellement épuisées).
-- Retour arrière : la contrainte reste permissive et le code ignore l'état
-- (la décision est alors lue « application non vérifiée », donc la
-- contradiction reste ouverte — jamais un faux « résolu »).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  -- Les colonnes de la migration 1785 peuvent manquer (déploiement partiel) : rien n'échoue.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'business_operation_attribute_arbitrations' AND column_name = 'application_state') THEN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_attribute_arbitrations_application_chk') THEN
      ALTER TABLE business_operation_attribute_arbitrations
        DROP CONSTRAINT business_operation_attribute_arbitrations_application_chk;
    END IF;
    ALTER TABLE business_operation_attribute_arbitrations
      ADD CONSTRAINT business_operation_attribute_arbitrations_application_chk
      CHECK (application_state IS NULL
             OR application_state IN ('RECEIVED', 'APPLYING', 'APPLIED', 'APPLY_FAILED', 'ESCALATED'));

    COMMENT ON COLUMN business_operation_attribute_arbitrations.application_state IS
      'Lot 115 (#791, E09) et carte #836 (E09) : RECEIVED (décision reçue), APPLYING (application en cours), APPLIED (application VÉRIFIÉE en base : champ, valeur, provenance, même fait et même période), APPLY_FAILED (sans effet — valeur protégée, saisie non gérée, écriture en échec : repris), ESCALATED (plafond de reprises épuisé : la contradiction reste visible et actionnable). NULL : décision sans effet à appliquer, ou ligne antérieure à la migration 1785.';
  END IF;
END $$;

-- E09 : la file de reprise ET les lignes escaladées, lues sans balayage de la table.
DROP INDEX IF EXISTS business_operation_attribute_arbitrations_apply_idx;
CREATE INDEX IF NOT EXISTS business_operation_attribute_arbitrations_apply_idx
  ON business_operation_attribute_arbitrations (account_id, id)
  WHERE application_state IN ('RECEIVED', 'APPLYING', 'APPLY_FAILED', 'ESCALATED');
