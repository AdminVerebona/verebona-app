-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1730 : « Situation de l'événement » d'un élément d'Agenda
-- (lot 114V, Trello #742, décision PO du 14/11/2026 : « A eu lieu | À prévoir »).
--
--   agenda_items.situation — INTENTION de l'utilisateur, indépendante de la
--     présence d'une date (matrice §3 de la carte) :
--       'A_PREVOIR'  : l'événement reste à organiser (avec ou sans date) ;
--       'A_EU_LIEU'  : l'événement a eu lieu (date connue ou inconnue) ;
--       NULL         : NON QUALIFIÉ (élément hérité ou produit par un
--                      traitement) — jamais reclassé arbitrairement.
--     Ce n'est PAS le retour du statut supprimé par le lot 113P (#715) :
--     `manual_status` reste obsolète et neutralisé (migration 1526) ; aucune
--     valeur « annulé », aucun « en retard », aucun calcul selon la date.
--   agenda_items.situation_source — provenance de la qualification :
--       'USER'      : choix transmis explicitement (formulaire, carte « À traiter ») ;
--       'DEFAULT'   : création manuelle sans choix transmis (défaut serveur « À prévoir ») ;
--       'MIGRATION' : reprise ci-dessous.
--   agenda_items.situation_decided_at — date de la qualification.
--
-- Colonnes NULLABLES sans valeur par défaut : ajout instantané (métadonnées) ;
-- l'ancienne version de l'application, qui ne les lit pas, continue de
-- fonctionner pendant le déploiement.
--
-- REPRISE (prudente, rejouable — seulement les éléments encore NON qualifiés,
-- jamais une qualification existante ; AUCUNE date écrite, modifiée ni
-- inventée ; aucun élément créé ni supprimé ; liens, documents, événements de
-- référence intacts) :
--   (a) « réalisé connu » : ancien statut « Réalisé » posé PAR L'UTILISATEUR,
--       archivé par la 1526 (LEGACY_STATUS_ARCHIVED, userGesture) → 'A_EU_LIEU'.
--       Un « réalisé » posé par le système (date échue) n'est PAS une preuve :
--       non repris. Un ancien « Annulé » n'est jamais converti.
--   (b) « ouvert connu » : tâche déclarée « Sans échéance » par l'utilisateur
--       (lot 77A), ou événement dont la date est STRICTEMENT FUTURE au moment
--       de la reprise → 'A_PREVOIR'.
--   (c) tout le reste (sans date non qualifié, date passée sans statut
--       utilisateur) : INCHANGÉ (NULL). Les éléments sans date concernés
--       relèvent de la carte de qualification « À traiter » existante
--       (DATA-AGENDA-DATE), dans ses conditions d'admissibilité habituelles.
--
-- Idempotente : ADD COLUMN IF NOT EXISTS ; contraintes créées si absentes ;
-- reprise filtrée sur `situation IS NULL`.
-- Retour arrière : ALTER TABLE agenda_items DROP COLUMN IF EXISTS situation,
--   DROP COLUMN IF EXISTS situation_source, DROP COLUMN IF EXISTS situation_decided_at;
--   (les cartes de date fermées sont recréées par le balayage suivant).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS situation TEXT;
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS situation_source TEXT;
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS situation_decided_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agenda_items_situation_check') THEN
    ALTER TABLE agenda_items ADD CONSTRAINT agenda_items_situation_check
      CHECK (situation IS NULL OR situation IN ('A_PREVOIR', 'A_EU_LIEU'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agenda_items_situation_source_check') THEN
    ALTER TABLE agenda_items ADD CONSTRAINT agenda_items_situation_source_check
      CHECK (situation_source IS NULL OR situation_source IN ('USER', 'DEFAULT', 'MIGRATION'));
  END IF;
END $$;

COMMENT ON COLUMN agenda_items.situation IS
  'Lot 114V (#742) : situation de l''événement — A_PREVOIR | A_EU_LIEU ; NULL = non qualifié (hérité, traitement). Indépendante de la date. N''est pas un statut (manual_status reste obsolète, lot 113P).';
COMMENT ON COLUMN agenda_items.situation_source IS
  'Lot 114V (#742) : provenance de la situation — USER (choix explicite) | DEFAULT (création manuelle sans choix transmis) | MIGRATION (reprise 1730).';

-- (a) Ancien « Réalisé » posé par l'utilisateur (archive 1526) → « A eu lieu ».
UPDATE agenda_items i
   SET situation = 'A_EU_LIEU', situation_source = 'MIGRATION', situation_decided_at = now()
 WHERE i.situation IS NULL
   AND EXISTS (SELECT 1 FROM agenda_occurrence_events e
                WHERE e.agenda_item_id = i.id AND e.account_id = i.account_id
                  AND e.event_type = 'LEGACY_STATUS_ARCHIVED'
                  AND e.detail_json ->> 'manualStatus' = 'realise'
                  AND e.detail_json ->> 'userGesture' = 'true')
   -- Jamais une contradiction écrite par la reprise : « A eu lieu » avec une date future.
   AND (i.start_date IS NULL OR i.start_date <= CURRENT_DATE);

-- (b) Ouvert connu : « Sans échéance » déclaré par l'utilisateur, ou date strictement future.
UPDATE agenda_items i
   SET situation = 'A_PREVOIR', situation_source = 'MIGRATION', situation_decided_at = now()
 WHERE i.situation IS NULL
   AND (i.no_deadline = true OR i.start_date > CURRENT_DATE);

-- (c) Le reste n'est pas reclassé.
