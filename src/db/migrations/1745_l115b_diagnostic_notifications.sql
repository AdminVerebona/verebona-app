-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1745 : instrumentation structurée des tentatives de livraison
-- (lot 115B, Trello #800 — « diagnostic exhaustif des échecs de notification »).
--
-- CE QUI MANQUAIT
--
-- `notification_deliveries` conserve aujourd'hui `status`, `last_error_code` et
-- `last_error_message`. Devant les 72 lignes « failed · mobile_push_config »
-- relevées le 16/11/2026, cela ne permet PAS de dire où la chaîne a cassé :
--   · l'obtention du jeton OAuth du compte de service a-t-elle échoué, ou
--     l'appel FCM lui-même ?
--   · quel statut HTTP le fournisseur a-t-il rendu (401, 403, 429, 500…) ?
--   · quel code exact FCM (`THIRD_PARTY_AUTH_ERROR`, `PERMISSION_DENIED`,
--     `UNREGISTERED`, `SENDER_ID_MISMATCH`…) ?
-- `mobile_push_config` est une CLASSE du code, pas une preuve de cause.
--
-- CE QUE LA MIGRATION AJOUTE (quatre colonnes de diagnostic, nullables)
--
--   failure_step          étape fautive de la chaîne, vocabulaire stable :
--                         'catalogue' | 'configuration' | 'jeton_appareil'
--                         | 'deduplication' | 'oauth_fournisseur'
--                         | 'appel_fournisseur' | 'reponse_fournisseur'
--                         | 'canal' | 'ecriture_locale'.
--                         NULL = non enregistré (lignes historiques).
--   provider_name         fournisseur réellement sollicité ('fcm', 'resend',
--                         'cloche'), NULL si aucun appel n'a eu lieu.
--   provider_status_code  statut HTTP rendu par le fournisseur, NULL s'il n'y
--                         a pas eu de réponse HTTP (jamais 0 par défaut :
--                         « non enregistré » doit rester distinguable).
--   provider_error_code   code d'erreur EXACT du fournisseur, tel que reçu
--                         (`UNREGISTERED`, `QUOTA_EXCEEDED`, `oauth_401`…).
--                         Distinct de `last_error_code`, qui reste la classe
--                         interne (`mobile_push_config`) affichée jusqu'ici.
--   failure_category      catégorie de cause : 'config' | 'transient'
--                         | 'rejected' | 'invalid_token' | 'ignore'.
--
-- AUCUNE DONNÉE SENSIBLE : ni jeton d'appareil, ni jeton OAuth, ni clé privée,
-- ni contenu de notification. Seuls des codes et des statuts.
--
-- HISTORIQUE : rien n'est reconstruit a posteriori. Les livraisons déjà
-- enregistrées gardent NULL partout — le BO les présente alors comme « non
-- enregistré », ce qui est la vérité. Inventer une cause serait pire que de
-- ne rien dire.
--
-- Colonnes NULLABLES sans valeur par défaut : ajout instantané (métadonnées
-- seulement) ; l'ancienne version de l'application, qui ne les écrit pas,
-- continue de fonctionner pendant le déploiement.
--
-- Idempotente et rejouable : ADD COLUMN IF NOT EXISTS, contraintes et index
-- créés seulement s'ils sont absents. Aucune ligne modifiée, aucune supprimée.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS failure_step         text;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS provider_name        text;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS provider_status_code integer;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS provider_error_code  text;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS failure_category     text;

-- Vocabulaires fermés : une valeur inattendue est un défaut de code, pas une
-- donnée à accepter en silence. NULL reste toujours permis (« non enregistré »).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notification_deliveries_failure_step_check'
  ) THEN
    ALTER TABLE notification_deliveries
      ADD CONSTRAINT notification_deliveries_failure_step_check
      CHECK (failure_step IS NULL OR failure_step IN (
        'catalogue', 'configuration', 'jeton_appareil', 'deduplication',
        'oauth_fournisseur', 'appel_fournisseur', 'reponse_fournisseur',
        'canal', 'ecriture_locale'
      )) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notification_deliveries_failure_category_check'
  ) THEN
    ALTER TABLE notification_deliveries
      ADD CONSTRAINT notification_deliveries_failure_category_check
      CHECK (failure_category IS NULL OR failure_category IN (
        'config', 'transient', 'rejected', 'invalid_token', 'ignore'
      )) NOT VALID;
  END IF;

  -- Statut HTTP plausible : écarte un 0 ou un code inventé.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notification_deliveries_provider_status_check'
  ) THEN
    ALTER TABLE notification_deliveries
      ADD CONSTRAINT notification_deliveries_provider_status_check
      CHECK (provider_status_code IS NULL OR (provider_status_code BETWEEN 100 AND 599)) NOT VALID;
  END IF;
END $$;

-- Agrégats du BO (« 72 échecs mobile_push_config sur 7 jours ») puis ouverture
-- du détail : la fenêtre et le code sont les deux seuls critères de tête.
CREATE INDEX IF NOT EXISTS notification_deliveries_diag_window_idx
  ON notification_deliveries (created_at DESC, status, last_error_code);

-- Pagination exhaustive à curseur du détail : (created_at, id) strictement
-- décroissant — aucun plafonnement, aucun doublon entre deux pages.
CREATE INDEX IF NOT EXISTS notification_deliveries_diag_cursor_idx
  ON notification_deliveries (created_at DESC, id DESC);
