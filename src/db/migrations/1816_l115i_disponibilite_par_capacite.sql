-- ─────────────────────────────────────────────────────────────────────────
-- Migration 1816 : IA — un verdict de disponibilité PAR CAPACITÉ (et par
-- modalité), et la dimension « projet du fournisseur » explicitée sans
-- jamais être inventée (lot 115, carte Trello #786, écart E05).
--
-- Complète 1692 (#771) et 1815 (#786) SANS rien défaire :
--   · la CLÉ CANONIQUE de l'état opérationnel devient
--     (fournisseur, modèle, accès, CAPACITÉ). 1692 avait déjà ajouté la
--     colonne `capability` (valeur par défaut `text_generation`), mais elle
--     restait DESCRIPTIVE : un refus constaté sur une capacité écrasait le
--     verdict de toutes les autres. Désormais :
--       – un refus propre à une capacité ne vaut QUE pour elle ;
--       – un refus de PORTÉE MODÈLE est écrit sur la capacité de base
--         (`text_generation`, prérequis de toutes les autres) et il vaut donc
--         pour tout l'accès — c'est la règle documentée d'extension, la seule ;
--       – un succès sur une capacité ne lève aucun refus d'une autre.
--     Les lignes existantes portent toutes `text_generation` : elles
--     deviennent le verdict de la capacité de base, sans aucune perte de
--     preuve, sans fusion implicite et sans portée fabriquée ;
--   · `provider_project` (état et historique) : accès/projet du fournisseur,
--     pseudonymisé, tel que l'application le CONNAÎT. L'application ne
--     connaît aujourd'hui AUCUN identifiant de projet (une clé Gemini ne le
--     restitue pas, et aucun référentiel ne le porte) : la colonne reste donc
--     vide — « non renseignée », jamais fusionnée avec l'empreinte de la clé,
--     jamais devinée. Elle est prête pour le jour où le projet sera déclaré à
--     côté de la clé ; voir `operationalProjectDimension()` et la fiche de
--     recette pour ce qu'il faudrait exactement.
--
-- IDEMPOTENTE et NON DESTRUCTIVE : `ADD COLUMN IF NOT EXISTS`, clé primaire
-- remplacée UNE seule fois (et seulement si elle porte encore trois
-- colonnes), aucune ligne modifiée ni supprimée, aucune colonne retirée.
-- Rejouable sans effet.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('ai_model_operational_status') IS NOT NULL THEN
    -- Projet / accès du fournisseur CONNU de l'application (jamais inventé).
    ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS provider_project TEXT;
    -- La capacité existe depuis 1692 ; sans elle, la clé ne peut pas être étendue.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'ai_model_operational_status' AND column_name = 'capability'
    ) AND EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = 'ai_model_operational_status'::regclass AND contype = 'p' AND array_length(conkey, 1) = 3
    ) THEN
      EXECUTE (
        SELECT format('ALTER TABLE ai_model_operational_status DROP CONSTRAINT %I', conname)
          FROM pg_constraint
         WHERE conrelid = 'ai_model_operational_status'::regclass AND contype = 'p'
      );
      ALTER TABLE ai_model_operational_status
        ADD CONSTRAINT ai_model_operational_status_pkey PRIMARY KEY (provider, model, key_fingerprint, capability);
    END IF;
  END IF;

  IF to_regclass('ai_model_operational_history') IS NOT NULL THEN
    ALTER TABLE ai_model_operational_history ADD COLUMN IF NOT EXISTS provider_project TEXT;
  END IF;
END $$;

COMMENT ON COLUMN ai_model_operational_status.capability IS
  'Capacité (et modalité) éprouvée : composante de la CLÉ CANONIQUE depuis le lot 115, carte #786. '
  'Un refus ne vaut que pour sa capacité ; seule la capacité de base (text_generation) étend sa portée '
  'à tout l''accès, parce qu''elle est le prérequis de toutes les autres.';

COMMENT ON COLUMN ai_model_operational_status.provider_project IS
  'Projet / accès du fournisseur CONNU de l''application, pseudonymisé (lot 115, carte #786). Vide tant '
  'qu''aucun identifiant de projet n''est déclaré : dimension inconnue EXPLICITÉE, jamais inventée ni '
  'fusionnée avec l''empreinte de la clé.';
