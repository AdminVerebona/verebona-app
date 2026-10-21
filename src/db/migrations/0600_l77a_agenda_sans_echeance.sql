-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0600 : option « Sans échéance » des événements d'agenda (lot 77A —
-- décision PO du 21/10/2026, suite lot 76C : conflit RES-14 / décision 72C).
--
--   agenda_items.no_deadline — l'UTILISATEUR a déclaré explicitement que la
--     tâche n'a pas de date à respecter. Seul le geste de l'utilisateur la
--     pose (création / modification d'un événement) ; aucun traitement
--     automatique (T4, projection) ne l'active. Cochée : la règle « À traiter »
--     DATA-AGENDA-DATE n'a plus de date à réclamer (critère « date nécessaire »
--     non justifié, motif NO_DEADLINE_BY_USER) — la carte existante est fermée
--     (motif tracé, jamais supprimée) et rouverte si l'option est retirée.
--
--   Déclencheur agenda_items_no_deadline_clear : une DATE et « sans échéance »
--     sont incompatibles. Toute écriture qui pose une date (tiroir, réponse à
--     une carte, assistant, T4, rattrapage, chemin futur) retire l'option —
--     jamais un refus d'écriture (une contrainte CHECK aurait fait échouer
--     ces chemins). Le service d'agenda neutralise de son côté les dates
--     quand l'utilisateur coche l'option.
--
-- Colonne NOT NULL DEFAULT false (constante) : ajout instantané (métadonnées,
-- aucune réécriture) ; l'ancienne version de l'application, qui ne la lit
-- pas, continue de fonctionner pendant le déploiement. Aucun index : la
-- colonne n'est lue qu'avec la ligne (balayage du compte, fiche).
-- Idempotente : ADD COLUMN IF NOT EXISTS ; CREATE OR REPLACE FUNCTION ;
-- DROP TRIGGER IF EXISTS puis CREATE TRIGGER.
-- Retour arrière : DROP TRIGGER IF EXISTS agenda_items_no_deadline_clear ON
-- agenda_items; DROP FUNCTION IF EXISTS agenda_items_no_deadline_clear();
-- ALTER TABLE agenda_items DROP COLUMN IF EXISTS no_deadline (les cartes
-- fermées restent fermées ; le balayage suivant les recrée selon la décision
-- 72C).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS no_deadline BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN agenda_items.no_deadline IS
  'Lot 77A : tâche « Sans échéance » déclarée par l''utilisateur (aucune date à réclamer). Incompatible avec une date (déclencheur agenda_items_no_deadline_clear).';

CREATE OR REPLACE FUNCTION agenda_items_no_deadline_clear() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.start_date IS NOT NULL AND NEW.no_deadline THEN
    NEW.no_deadline := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agenda_items_no_deadline_clear ON agenda_items;
CREATE TRIGGER agenda_items_no_deadline_clear
  BEFORE INSERT OR UPDATE OF start_date, no_deadline ON agenda_items
  FOR EACH ROW EXECUTE FUNCTION agenda_items_no_deadline_clear();
