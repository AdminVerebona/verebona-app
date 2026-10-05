-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0241 : dépôts reprenables et idempotents (APP-PERF-30, APP-PERF-24).
--
-- 1. Identifiant d'opération de dépôt, fourni par le client à `presign` puis à
--    `confirm` (une opération logique = un fichier = au plus un document) :
--      · upload_operation_id        : clé d'idempotence (unique par
--        utilisateur, index CONCURRENTLY dans 0241_upload_operations_idx_1) ;
--      · upload_request_fingerprint : empreinte de la demande presign (nom,
--        type, taille, empreinte, bien, compte) — même clé + autre demande
--        ⇒ refus 409 ;
--      · confirm_fingerprint        : empreinte des métadonnées confirmées —
--        une confirmation rejouée à l'identique rend le résultat existant.
--    Colonnes NULL pour toutes les lignes existantes et pour les clients qui
--    n'envoient pas de clé (comportement antérieur inchangé).
--
-- 2. Empreintes de repli : l'ancien dialogue enregistrait « placeholder-hash »
--    quand le calcul échouait. Cette valeur commune faisait de tous les
--    fichiers concernés des « doublons exacts » (détection de fusion,
--    dédoublonnage des dépenses et des sources de l'assistant). NULL est
--    l'état « empreinte non calculée » déjà compris par tous les lecteurs.
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS upload_operation_id TEXT;
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS upload_request_fingerprint TEXT;
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS confirm_fingerprint TEXT;

UPDATE asset_files SET sha256_hash = NULL WHERE sha256_hash = 'placeholder-hash';
