-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 2011 : PROVENANCE DU TITRE AU NIVEAU DU CHAMP — titre d'un élément
-- d'Agenda (`agenda_items.title`) (carte Trello #859). Fichier 2/2 : modèle,
-- motifs et retour arrière décrits en tête de la migration 2010.
-- Additive, idempotente, rejouable, non destructive ; aucun titre réécrit.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS title_provenance JSONB;

COMMENT ON COLUMN agenda_items.title_provenance IS
  'Carte #859 : dernier geste sur title (origin SYSTEM|USER|UNKNOWN, value, previous, at, reason, actorUserId, channel, evidence). Tenue par déclencheur ; NULL = stock (repli sur les traces).';

-- ── Agenda ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION agenda_items_title_provenance() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  d jsonb := NULLIF(current_setting('verebona.title_declaration', true), '')::jsonb;
  origine text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Restauration d'un instantané : provenance conservée telle quelle.
    IF NEW.title_provenance IS NULL THEN
      NEW.title_provenance := COALESCE(d, jsonb_build_object(
          'origin', CASE WHEN NEW.is_automatic THEN 'SYSTEM' ELSE 'USER' END, 'reason', 'CREATED'))
        || jsonb_build_object('value', NEW.title, 'previous', NULL, 'at', now());
    END IF;
    RETURN NEW;
  END IF;
  -- Provenance écrite explicitement par l'instruction : conservée.
  IF NEW.title_provenance IS DISTINCT FROM OLD.title_provenance THEN
    RETURN NEW;
  END IF;
  IF NEW.title IS DISTINCT FROM OLD.title THEN
    origine := COALESCE(d ->> 'origin', CASE
      WHEN NOT NEW.is_automatic THEN 'USER'
      WHEN COALESCE(NEW.is_automatic_modified, false) AND NOT COALESCE(OLD.is_automatic_modified, false) THEN 'USER'
      WHEN NOT COALESCE(NEW.is_automatic_modified, false) THEN 'SYSTEM'
      ELSE 'UNKNOWN' END);
    NEW.title_provenance := COALESCE(d, jsonb_build_object('reason', 'UNDECLARED_TITLE_WRITE'))
      || jsonb_build_object('origin', origine, 'value', NEW.title, 'previous', OLD.title, 'at', now());
  ELSIF d IS NOT NULL AND d ->> 'origin' = 'USER' AND COALESCE((d ->> 'explicit')::boolean, false) THEN
    NEW.title_provenance := d || jsonb_build_object('value', NEW.title, 'previous', OLD.title, 'at', now());
  ELSIF OLD.title_provenance IS NULL AND OLD.is_automatic AND NOT COALESCE(OLD.is_automatic_modified, false)
        AND COALESCE(NEW.is_automatic_modified, false) THEN
    -- Stock : première modification de l'utilisateur (date, description…), titre inchangé — l'état prouvé
    -- juste avant (élément automatique jamais touché : titre du système) est figé.
    NEW.title_provenance := jsonb_build_object('origin', 'SYSTEM', 'reason', 'SYSTEM_TITLE_BEFORE_FIRST_USER_EDIT',
      'value', NEW.title, 'previous', NULL, 'at', now());
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS agenda_items_title_provenance ON agenda_items;
CREATE TRIGGER agenda_items_title_provenance
  BEFORE INSERT OR UPDATE OF title, is_automatic_modified, title_provenance ON agenda_items
  FOR EACH ROW EXECUTE FUNCTION agenda_items_title_provenance();
