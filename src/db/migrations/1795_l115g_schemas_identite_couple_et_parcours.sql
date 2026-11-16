-- ─────────────────────────────────────────────────────────────────────────
-- Migration 1795 : IA — IDENTITÉ ÉLARGIE d'un couple de compatibilité de
-- schéma, VERSION DE MODÈLE RÉELLEMENT SERVIE, et index de PARCOURS
-- EXHAUSTIF (lot 115, carte Trello #784 « IA T1 / passerelle — compléter
-- #776 », §A3 et §B1 ; suite de la migration 1710, carte #776).
--
-- Écarts corrigés, tels que la carte les constate :
--
--   · A3 — la clé d'un couple ne portait ni le PROFIL DE GÉNÉRATION effectif
--     (plafond de sortie, réflexion, température), ni la version du modèle
--     réellement SERVIE, distincte de son nom. Un appel au même nom de modèle
--     avec un autre profil ne contraint pas le décodage de la même façon ; un
--     alias mis à jour chez le fournisseur ne doit pas hériter d'une
--     qualification obsolète.
--       generation_profile_hash   empreinte du profil effectif, composante de
--                                 la clé ('-' : aucun paramètre matériel —
--                                 valeur des lignes écrites avant ce lot, dont
--                                 la clé reste donc valide) ;
--       served_model_version      dernière version servie observée ;
--       served_version_at_state   version servie au moment où l'état courant a
--                                 été écrit (comparaison : une version
--                                 différente rend le prochain essai avec
--                                 schéma dû — un seul, réservé) ;
--       version_uncertain         le fournisseur n'a pas indiqué la version :
--                                 incertitude MARQUÉE, rien n'est inventé.
--
--   · B1 — les lectures de la mémoire partagée étaient bornées aux 2 000
--     lignes les plus récentes : un couple actif mais ancien pouvait être
--     absent du cache et de la réévaluation des alertes. L'index par
--     (state, key_id) rend le parcours exhaustif, paginé et reprenable, dans
--     un ordre stable qu'une mise à jour concurrente ne déplace pas.
--
-- AUCUNE donnée n'est perdue, aucune ligne n'est réécrite : les couples
-- mémorisés pour l'ancienne projection restent lisibles, HISTORIQUES.
-- Aucun contenu de document, de prompt ni de schéma : empreintes,
-- identifiants, versions, compteurs et dates. Aucune donnée de compte.
--
-- IDEMPOTENTE et NON DESTRUCTIVE : ADD COLUMN / CREATE INDEX IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE ai_schema_compatibility
  ADD COLUMN IF NOT EXISTS generation_profile_hash TEXT NOT NULL DEFAULT '-';

ALTER TABLE ai_schema_compatibility
  ADD COLUMN IF NOT EXISTS served_model_version TEXT;

ALTER TABLE ai_schema_compatibility
  ADD COLUMN IF NOT EXISTS served_version_at_state TEXT;

ALTER TABLE ai_schema_compatibility
  ADD COLUMN IF NOT EXISTS version_uncertain BOOLEAN NOT NULL DEFAULT FALSE;

-- Parcours exhaustif et reprenable des couples d'un état (réévaluation des
-- alertes, rattrapage) : ordre stable par clé, jamais par date de mise à jour.
CREATE INDEX IF NOT EXISTS ai_schema_compatibility_state_key_idx
  ON ai_schema_compatibility (state, key_id);

-- Essais de réexamen dus : lecture directe sans parcours complet.
CREATE INDEX IF NOT EXISTS ai_schema_compatibility_retest_idx
  ON ai_schema_compatibility (next_retest_at)
  WHERE state IN ('REJECTED_CONFIRMED', 'NEEDS_RECHECK');

COMMENT ON COLUMN ai_schema_compatibility.generation_profile_hash IS
  'Empreinte du profil de génération effectif (plafond de sortie, réflexion, température, mode JSON) : composante de '
  'l''identité du couple — lot 115, carte #784. ''-'' : aucun paramètre matériel (clé historique inchangée).';

COMMENT ON COLUMN ai_schema_compatibility.served_model_version IS
  'Dernière version de modèle réellement SERVIE observée pour ce couple (lot 115, carte #784). NULL : jamais observée.';

COMMENT ON COLUMN ai_schema_compatibility.served_version_at_state IS
  'Version servie au moment où l''état courant a été écrit : une version différente observée ensuite rend le prochain '
  'essai avec schéma dû (un seul, réservé) — le refus mémorisé ne concerne plus la version servie aujourd''hui.';

COMMENT ON COLUMN ai_schema_compatibility.version_uncertain IS
  'Le fournisseur n''a pas indiqué la version servie lors du dernier constat : incertitude marquée, aucune version '
  'inventée, aucun état déduit.';
