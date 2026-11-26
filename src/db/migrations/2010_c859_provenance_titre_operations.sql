-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 2010 : PROVENANCE DU TITRE AU NIVEAU DU CHAMP — intitulé d'une
-- Opération (`business_operations.technical_label`) et titre d'un élément
-- d'Agenda (`agenda_items.title`) (carte Trello #859, §2 et §3.C).
--
-- Pourquoi une extension : les mécanismes existants ne suffisent pas.
--   · `attribute_provenance.fields.label` (lot 78A) dit QUELLE SOURCE porte la
--     valeur, déduit d'une égalité de chaînes : il ne dit pas QUI a choisi le
--     titre, et il est réécrit par chaque consolidation ;
--   · `is_automatic_modified` (Agenda) et « toutes les sources gérées par T3 »
--     (Opération) sont GLOBAUX : une correction de date suffit à bloquer toute
--     amélioration du titre ;
--   · l'historique de l'Opération (`business_operation_history`) identifie le
--     champ, la valeur, l'ordre et l'acteur, mais pas l'ORIGINE déclarée du
--     geste (le motif peut être fourni par l'appelant). Il reste lu comme
--     preuve de repli pour le stock (`title-provenance.ts`).
--
--   · `title_provenance` (JSONB, nullable, les deux tables) : DERNIER geste
--     sur le titre — origine SYSTEM | USER | UNKNOWN, valeur posée, valeur
--     précédente, date, motif, acteur, canal, référence probante. Tenue par
--     DÉCLENCHEUR dans la MÊME instruction que l'écriture du titre, d'après la
--     DÉCLARATION de la transaction (`verebona.title_declaration`, posée par le
--     code juste avant l'écriture puis retirée). Une écriture NON déclarée
--     (ancienne version de l'application, SQL direct) :
--       - Opération : provenance EFFACÉE (NULL) — le code se replie sur
--         l'historique, jamais sur une provenance devenue fausse ;
--       - Agenda : élément saisi → USER ; élément automatique jamais modifié
--         par l'utilisateur → SYSTEM (convention existante §14.6) ; première
--         modification de l'utilisateur dans la même écriture → USER ; élément
--         déjà modifié → UNKNOWN (rien ne sera réécrit automatiquement).
--     Première modification de l'utilisateur d'un élément automatique du STOCK
--     (provenance absente), titre inchangé : l'état PROUVÉ juste avant (SYSTEM,
--     élément jamais touché) est figé — une correction de date ne fait plus
--     perdre la provenance du titre.
--
-- Additive, idempotente, rejouable, NON DESTRUCTIVE : aucune donnée reprise,
-- AUCUN titre réécrit, aucune conversion du stock en SYSTEM (colonne NULL : le
-- code reconstitue la provenance depuis des traces fiables, sinon INCONNU).
-- Retour arrière : DROP TRIGGER … ; DROP FUNCTION … ; ALTER TABLE … DROP
-- COLUMN title_provenance. Le code lit la colonne par `to_jsonb(ligne)` : son
-- absence vaut « aucune provenance » (repli sur les traces, sinon INCONNU).
-- ──────────────────────────────────────────────────────────────────────────────
-- ──────────────────────────────────────────────────────────────────────────────
-- Fichier 1/2 (Opération) ; l'Agenda est en 2011 (fichier séparé : la migration de l'Opération est
-- rejouée seule par le contrôle de schéma du socle des Opérations, l39-o1).
SET LOCAL lock_timeout = '5s';

ALTER TABLE business_operations ADD COLUMN IF NOT EXISTS title_provenance JSONB;

COMMENT ON COLUMN business_operations.title_provenance IS
  'Carte #859 : dernier geste sur technical_label (origin SYSTEM|USER|UNKNOWN, value, previous, at, reason, actorUserId, channel, evidence). Tenue par déclencheur ; NULL = repli sur business_operation_history.';
-- ── Opération ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION business_operations_title_provenance() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  d jsonb := NULLIF(current_setting('verebona.title_declaration', true), '')::jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.title_provenance := CASE WHEN d IS NULL THEN NULL
      ELSE d || jsonb_build_object('value', NEW.technical_label, 'previous', NULL, 'at', now()) END;
    RETURN NEW;
  END IF;
  IF NEW.technical_label IS DISTINCT FROM OLD.technical_label THEN
    NEW.title_provenance := CASE WHEN d IS NULL THEN NULL
      ELSE d || jsonb_build_object('value', NEW.technical_label, 'previous', OLD.technical_label, 'at', now()) END;
  ELSIF d IS NOT NULL AND d ->> 'origin' = 'USER' AND COALESCE((d ->> 'explicit')::boolean, false) THEN
    -- Geste EXPLICITE de choix du titre, valeur identique : tracé.
    NEW.title_provenance := d || jsonb_build_object('value', NEW.technical_label, 'previous', OLD.technical_label, 'at', now());
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS business_operations_title_provenance ON business_operations;
CREATE TRIGGER business_operations_title_provenance
  BEFORE INSERT OR UPDATE OF technical_label ON business_operations
  FOR EACH ROW EXECUTE FUNCTION business_operations_title_provenance();
