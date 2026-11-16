-- ─────────────────────────────────────────────────────────────────────────
-- Migration 1815 : IA — admission des envois, ordre et idempotence des
-- contrôles de disponibilité, réservation partagée des recontrôles
-- (lot 115, carte Trello #786 « Corriger les 8 écarts du lot 114Q »).
--
-- Complète la migration 1692 (#771) SANS rien défaire :
--   · contexte d'accès IMMUABLE du contrôle (E05) : environnement et version
--     d'API figés à l'ENVOI, à côté de la capacité et du point d'accès déjà
--     tracés par 1692. Aucune dimension inventée : une colonne laissée vide
--     reste « non renseignée », jamais fusionnée avec une autre ;
--   · identifiant stable du contrôle (E04) : `check_id`, figé à la source
--     (sonde, qualification, test de clé, refus d'un appel réel) et transmis
--     jusqu'à l'écriture. Index UNIQUE sur (fournisseur, modèle, accès,
--     identifiant) dans l'historique : rejouer le même contrôle n'ouvre pas
--     une seconde ligne, ne repousse aucune échéance et ne change aucun
--     compteur ;
--   · dernier RÉSULTAT conservé à part du dernier VERDICT retenu (E04) :
--     `last_result_status`, `last_result_at`, `last_result_kind` — un
--     recontrôle non concluant après un refus confirmé est visible SANS
--     effacer le refus (qui reste opposable) ;
--   · motif d'écart d'un contrôle historisé (`discarded_reason`) : hors
--     ordre, doublon, ou résultat d'un accès qui n'est plus l'accès actif ;
--   · réservation ATOMIQUE et partagée des recontrôles (E07) :
--     `probe_lease_owner`, `probe_lease_until`, `probe_lease_at` — une seule
--     instance sonde une route à son échéance ; le bail expire (reprise après
--     arrêt brutal du détenteur) et aucun ancien détenteur ne peut écrire une
--     réservation périmée.
--
-- IDEMPOTENTE et NON DESTRUCTIVE : `ADD COLUMN IF NOT EXISTS`,
-- `CREATE INDEX IF NOT EXISTS`. Aucune ligne modifiée ni supprimée, aucune
-- colonne ni contrainte retirée. Rejouable sans effet.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('ai_model_operational_status') IS NOT NULL THEN
    -- Contexte d'accès immuable (E05), à côté de capability / endpoint (1692).
    ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS environment TEXT;
    ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS api_version TEXT;
    -- Identifiant stable du contrôle retenu (E04).
    ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS check_id TEXT;
    -- Dernier RÉSULTAT reçu, conservé à part du verdict retenu (E04, E08).
    ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS last_result_status TEXT;
    ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS last_result_kind TEXT;
    ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS last_result_at TIMESTAMPTZ;
    -- Réservation partagée du recontrôle (E07).
    ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS probe_lease_owner TEXT;
    ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS probe_lease_until TIMESTAMPTZ;
    ALTER TABLE ai_model_operational_status ADD COLUMN IF NOT EXISTS probe_lease_at TIMESTAMPTZ;
  END IF;

  IF to_regclass('ai_model_operational_history') IS NOT NULL THEN
    ALTER TABLE ai_model_operational_history ADD COLUMN IF NOT EXISTS check_id TEXT;
    ALTER TABLE ai_model_operational_history ADD COLUMN IF NOT EXISTS environment TEXT;
    ALTER TABLE ai_model_operational_history ADD COLUMN IF NOT EXISTS api_version TEXT;
    ALTER TABLE ai_model_operational_history ADD COLUMN IF NOT EXISTS discarded_reason TEXT;
  END IF;
END $$;

-- Idempotence (E04) : un identifiant de contrôle n'est écrit qu'une fois par
-- route et par accès. Partiel : les lignes antérieures (sans identifiant) sont
-- toutes conservées.
CREATE UNIQUE INDEX IF NOT EXISTS ai_model_operational_history_check_uidx
  ON ai_model_operational_history (provider, model, key_fingerprint, check_id)
  WHERE check_id IS NOT NULL;

-- Échéance + réservation : lecture des routes à recontrôler par le cron.
CREATE INDEX IF NOT EXISTS ai_model_operational_status_lease_idx
  ON ai_model_operational_status (provider, next_probe_at)
  WHERE next_probe_at IS NOT NULL;

COMMENT ON COLUMN ai_model_operational_history.check_id IS
  'Identifiant stable du contrôle, figé à la source et transmis jusqu''à l''écriture (lot 115, carte #786) : '
  'rejouer le même contrôle ne crée pas une seconde ligne et ne change aucun compteur.';
