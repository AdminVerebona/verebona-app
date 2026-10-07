-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0257 (déclencheur) : fermeture IMMÉDIATE de l'action
-- « À traiter » LINK-ASSET dès qu'un document est rattaché à un bien, quel
-- que soit l'écran ou le traitement qui le rattache (lot 28, ticket P0,
-- « Cas D — l'utilisateur rattache ensuite le document depuis une autre
-- interface »).
--
-- Tous les rattachements passent par `document_asset_links` : les colonnes
-- historiques d'asset_files (asset_id, linked_asset_id, equipment_id…) y
-- sont reflétées par le déclencheur de la migration 0221 (liens
-- LEGACY_COLUMN), les liens USER / AI / MIGRATION y sont écrits directement
-- par `services/documents/document-asset-links`. Un seul point d'écoute
-- couvre donc le tiroir document, le déplacement en masse, la fiche
-- équipement, le dépôt, l'assistant, les rattrapages et tout chemin futur.
--
-- Règle : un lien ACTIF vers un BIEN de rôle PRIMARY ou SECONDARY satisfait
-- la règle (« un document doit toujours être rattaché à au moins un bien »).
-- Un lien MENTIONED (bien seulement cité par l'analyse) ne la satisfait pas.
-- L'action active du document (relation `assetIds`, ARBITRATE ou COMPLETE)
-- est fermée : resolved_at = now(), motif USER_COMPLETED. Une résolution
-- depuis la carte réécrit ensuite le motif (USER_ARBITRATED) dans la même
-- transaction. Le détachement n'est pas traité ici : la réapparition du
-- problème est l'affaire du pont documentaire et du balayage horaire.
--
-- Second point d'écoute, sur asset_files (asset_id, linked_asset_id) : la
-- 0221 ne crée pas de lien LEGACY_COLUMN quand la cible est déjà liée par un
-- autre lien actif — typiquement un bien seulement CITÉ (MENTIONED, AI) que
-- l'utilisateur choisit ensuite. Sans lui, ce rattachement-là ne fermerait
-- l'action qu'au balayage suivant.
--
-- Coût : une mise à jour par clé (account_id, target_type, target_id) servie
-- par l'index unique partiel des actions actives (0147), seulement pour un
-- lien actif vers un bien — jamais de balayage.
--
-- Idempotente : CREATE OR REPLACE FUNCTION ; DROP TRIGGER IF EXISTS puis
-- CREATE TRIGGER. Retour arrière : DROP TRIGGER document_asset_links_close_link_asset
-- ON document_asset_links; DROP TRIGGER asset_files_close_link_asset ON
-- asset_files; DROP FUNCTION to_process_close_link_asset(),
-- to_process_close_link_asset_file().
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION to_process_close_link_asset() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'ACTIVE'
     AND NEW.asset_id IS NOT NULL
     AND NEW.link_role IN ('PRIMARY', 'SECONDARY') THEN
    UPDATE to_process_actions
       SET resolved_at = now(),
           resolution_reason = 'USER_COMPLETED',
           updated_at = now()
     WHERE account_id = NEW.account_id
       AND target_type = 'DOCUMENT'
       AND target_id = NEW.file_id
       AND relation_key = 'assetIds'
       AND resolved_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS document_asset_links_close_link_asset ON document_asset_links;

CREATE TRIGGER document_asset_links_close_link_asset
  AFTER INSERT OR UPDATE OF status, asset_id, link_role ON document_asset_links
  FOR EACH ROW
  EXECUTE FUNCTION to_process_close_link_asset();

CREATE OR REPLACE FUNCTION to_process_close_link_asset_file() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NULL AND (NEW.asset_id IS NOT NULL OR NEW.linked_asset_id IS NOT NULL) THEN
    UPDATE to_process_actions
       SET resolved_at = now(),
           resolution_reason = 'USER_COMPLETED',
           updated_at = now()
     WHERE account_id = NEW.account_id
       AND target_type = 'DOCUMENT'
       AND target_id = NEW.id
       AND relation_key = 'assetIds'
       AND resolved_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS asset_files_close_link_asset ON asset_files;

-- Ne se déclenche que si l'une des deux colonnes CHANGE (les mises à jour
-- fréquentes d'état d'analyse, de classement ou de titre ne le sollicitent pas).
CREATE TRIGGER asset_files_close_link_asset
  AFTER UPDATE OF asset_id, linked_asset_id ON asset_files
  FOR EACH ROW
  WHEN (OLD.asset_id IS DISTINCT FROM NEW.asset_id OR OLD.linked_asset_id IS DISTINCT FROM NEW.linked_asset_id)
  EXECUTE FUNCTION to_process_close_link_asset_file();
