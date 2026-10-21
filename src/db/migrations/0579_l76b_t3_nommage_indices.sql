-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0579 : T3 — harmonisation documentaire, indices textuels de
-- rapprochement (lot 76B, C6).
--
--   document_naming_members
--       text_keys    : références discriminantes lues dans le texte extrait
--                      (formes génériques, normalisées) — indices `x:` de
--                      rapprochement des documents sans contrat ni Opération
--                      structurés ; bornés (émetteurs, nombre de documents) :
--                      jamais un regroupement massif ;
--       text_version : version de l'extraction ayant produit `text_keys`
--                      (cache : le texte n'est relu qu'à une nouvelle
--                      extraction, jamais à chaque passage).
--
-- Colonnes NULLables sans défaut : ajout instantané. Idempotente, rejouable.
-- Retour arrière : le code du lot 75 ignore ces colonnes.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE document_naming_members ADD COLUMN IF NOT EXISTS text_keys    TEXT[];
ALTER TABLE document_naming_members ADD COLUMN IF NOT EXISTS text_version TEXT;
