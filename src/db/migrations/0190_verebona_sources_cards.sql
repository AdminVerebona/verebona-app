-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0190 : sources complètes et cartes de résultats de l'assistant
-- CDC Assistant §19.3, §19.5, §22.2, §22.3, §27.8, §28.4, 37.1.
--
-- 1. `verebona_message_sources` : les 8 sources d'une réponse sont désormais
--    TOUTES persistées (elles étaient tronquées à 5 avant écriture, avec leurs
--    liens claim → source). Le panneau affiche type lisible, bien lié, date
--    utile et statut (§19.5) : ces libellés sont figés à l'écriture, comme le
--    titre et l'extrait (§19.10 — un objet renommé ne réécrit pas l'historique).
-- 2. `verebona_messages.result_groups_json` : cartes de résultats groupées par
--    type (§11.3), relues à la reprise d'un fil.
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE verebona_message_sources ADD COLUMN IF NOT EXISTS linked_asset_label text;
ALTER TABLE verebona_message_sources ADD COLUMN IF NOT EXISTS useful_date text;
ALTER TABLE verebona_message_sources ADD COLUMN IF NOT EXISTS status_label text;

ALTER TABLE verebona_messages ADD COLUMN IF NOT EXISTS result_groups_json jsonb;
