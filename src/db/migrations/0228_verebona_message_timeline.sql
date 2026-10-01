-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0228 : chronologie persistée des réponses de l'assistant
-- (CDC 15 T2-35, reliquat R1 ; plan lot 19, volet C).
--
-- `verebona_messages.timeline_events_json` : `events[]` de la réponse
-- (une entrée par événement : date, texte, référence de l'objet, lien), écrit
-- par `persistTurn` et relu à la reprise d'un fil (GET conversation). Sans
-- elle, la chronologie redevenait du texte au rechargement.
--
-- NULL : réponse sans chronologie — toutes les réponses antérieures, et
-- toutes celles produites en lecture `legacy` (aucun `events[]`).
--
-- VERROUS : ADD COLUMN nullable sans défaut = modification de catalogue seule,
-- mais sous verrou ACCESS EXCLUSIVE sur une table très écrite : `lock_timeout`
-- borne l'attente à 5 s. Dépassé : la migration échoue, est signalée
-- (/api/health) et retentée au prochain démarrage ; l'écriture de la
-- chronologie est alors ignorée (colonne détectée absente). `SET LOCAL` :
-- réglage limité à la transaction implicite du fichier.
--
-- Idempotente : ADD COLUMN IF NOT EXISTS.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE verebona_messages ADD COLUMN IF NOT EXISTS timeline_events_json jsonb;
