-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1526 : agenda — NEUTRALISATION du statut d'événement
-- (lot 113P, ticket #715, décision PO du 06/11/2026 : « Un événement existe à
-- une date ou une période. Il n'a pas de statut métier. »).
--
-- La colonne `agenda_items.manual_status` ('realise' | 'annule') est CONSERVÉE
-- (aucune suppression de colonne) mais devient OBSOLÈTE :
--   1. ARCHIVAGE réversible : pour chaque élément portant un statut, une trace
--      `agenda_occurrence_events` LEGACY_STATUS_ARCHIVED (statut, drapeau
--      `is_automatic_modified` d'avant, geste utilisateur ou non, preuve 0945)
--      — une seule par élément (rejouable) ;
--   2. PROTECTION conservée : un statut posé PAR L'UTILISATEUR (trace
--      STATUS_CHANGED, ou aucune trace de pose automatique) sur un élément
--      AUTOMATIQUE devient `is_automatic_modified = true` — l'élément reste
--      protégé des réécritures et retraits automatiques (§14.6). Un « réalisé »
--      posé par le SYSTÈME (STATUS_AUTO_COMPLETED) ne protège rien ;
--   3. NEUTRALISATION : `manual_status = NULL` (les dates, documents, preuves,
--      liens et Opérations sont INTACTS ; aucun événement n'est supprimé ; un
--      « Réalisé » n'est JAMAIS converti en preuve de paiement ni de
--      réalisation) ;
--   4. GARDE : déclencheur `agenda_items_manual_status_obsolete` — toute écriture
--      d'un statut (ancienne API, cache PWA, restauration d'instantané) est
--      ramenée à NULL. Les colonnes 0945 (`completion_proof_*`) restent en base,
--      ignorées (aucun lecteur).
--
-- Les anciens événements « Annulé » redeviennent visibles à leur date
-- (l'utilisateur les supprime s'ils n'ont pas existé). Conversion optionnelle en
-- suppression tracée : décision du PO (procédure dans
-- docs/exploitation/recette-113p-agenda-sans-statut.md, NON appliquée ici).
--
-- Idempotente, rejouable. RETOUR ARRIÈRE (réversible) :
--   DROP TRIGGER IF EXISTS agenda_items_manual_status_obsolete ON agenda_items;
--   UPDATE agenda_items i SET manual_status = e.detail_json ->> 'manualStatus',
--          is_automatic_modified = (e.detail_json ->> 'isAutomaticModifiedBefore')::boolean
--     FROM agenda_occurrence_events e
--    WHERE e.agenda_item_id = i.id AND e.event_type = 'LEGACY_STATUS_ARCHIVED';
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

-- 1. Archivage (une trace par élément, jamais deux).
INSERT INTO agenda_occurrence_events (agenda_item_id, account_id, event_type, detail_json)
SELECT i.id, i.account_id, 'LEGACY_STATUS_ARCHIVED',
       jsonb_build_object(
         'manualStatus', trim(i.manual_status),
         'isAutomaticModifiedBefore', COALESCE(i.is_automatic_modified, false),
         'userGesture', (
           EXISTS (SELECT 1 FROM agenda_occurrence_events e
                    WHERE e.agenda_item_id = i.id AND e.event_type = 'STATUS_CHANGED')
           OR NOT EXISTS (SELECT 1 FROM agenda_occurrence_events e
                           WHERE e.agenda_item_id = i.id AND e.event_type = 'STATUS_AUTO_COMPLETED')),
         'completionProofFileId', to_jsonb(i) -> 'completion_proof_file_id',
         'completionProvenAt', to_jsonb(i) -> 'completion_proven_at',
         'migration', '1526')
  FROM agenda_items i
 WHERE NULLIF(trim(COALESCE(i.manual_status, '')), '') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM agenda_occurrence_events e
                    WHERE e.agenda_item_id = i.id AND e.event_type = 'LEGACY_STATUS_ARCHIVED');

-- 2. Protection conservée (geste de l'utilisateur sur un élément automatique).
UPDATE agenda_items i SET is_automatic_modified = true
 WHERE i.is_automatic AND NOT COALESCE(i.is_automatic_modified, false)
   AND NULLIF(trim(COALESCE(i.manual_status, '')), '') IS NOT NULL
   AND (EXISTS (SELECT 1 FROM agenda_occurrence_events e
                 WHERE e.agenda_item_id = i.id AND e.event_type = 'STATUS_CHANGED')
        OR NOT EXISTS (SELECT 1 FROM agenda_occurrence_events e
                        WHERE e.agenda_item_id = i.id AND e.event_type = 'STATUS_AUTO_COMPLETED'));

-- 3. Neutralisation (chaîne vide comprise).
UPDATE agenda_items SET manual_status = NULL WHERE manual_status IS NOT NULL;

-- 4. Garde : plus aucun statut écrit, quel que soit l'écrivain.
CREATE OR REPLACE FUNCTION agenda_items_manual_status_obsolete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.manual_status := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agenda_items_manual_status_obsolete ON agenda_items;
CREATE TRIGGER agenda_items_manual_status_obsolete
  BEFORE INSERT OR UPDATE OF manual_status ON agenda_items
  FOR EACH ROW WHEN (NEW.manual_status IS NOT NULL)
  EXECUTE FUNCTION agenda_items_manual_status_obsolete();

COMMENT ON COLUMN agenda_items.manual_status IS
  'OBSOLÈTE (lot 113P, #715) : plus de statut d''événement. Toujours NULL (déclencheur agenda_items_manual_status_obsolete) ; anciennes valeurs archivées dans agenda_occurrence_events LEGACY_STATUS_ARCHIVED.';
