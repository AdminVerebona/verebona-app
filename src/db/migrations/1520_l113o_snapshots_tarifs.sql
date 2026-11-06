-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1520 : page tarifaire RÉELLEMENT reçue (lot 113O, carte #713).
--
-- Le lot 109L ne gardait qu'un extrait de 600 caractères de la page lue : le
-- diagnostic « avant correction » exigé par le ticket (ABSENT de
-- gemini-2.5-flash-lite en préproduction alors que la fixture du 04/11 le
-- tarife) était impossible sans accès à la base. Désormais :
--   · `ai_model_pricing_page_snapshots` : contenu INTÉGRAL reçu, dédoublonné
--     par empreinte SHA-256 (une page inchangée n'est stockée qu'une fois),
--     sans secret (page publique, aucune clé envoyée ; motifs de clé masqués
--     par précaution, compteur `redactions`) ; conservation bornée par le code
--     (dernières empreintes seulement) ;
--   · `ai_model_pricing_refresh_log` : lien vers ce contenu, identifiants de
--     modèles effectivement extraits, nombre de sections et couverture — la
--     référence de la prochaine lecture (chute de couverture = ÉCHEC documenté,
--     jamais suppression massive).
-- Additive, idempotente, rejouable. Retour arrière : DROP TABLE / colonnes
-- (aucune donnée métier).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_model_pricing_page_snapshots (
  id             BIGSERIAL   PRIMARY KEY,
  fingerprint    TEXT        NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seen_count     INTEGER     NOT NULL DEFAULT 1,
  requested_url  TEXT,
  final_url      TEXT,
  http_status    INTEGER,
  content_type   TEXT,
  page_bytes     INTEGER     NOT NULL DEFAULT 0,
  page_format    TEXT,
  body           TEXT        NOT NULL,
  truncated      BOOLEAN     NOT NULL DEFAULT FALSE,
  redactions     INTEGER     NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_model_pricing_page_snapshots_fp_uq ON ai_model_pricing_page_snapshots (fingerprint);
CREATE INDEX IF NOT EXISTS ai_model_pricing_page_snapshots_seen_idx ON ai_model_pricing_page_snapshots (last_seen_at DESC);

DO $$
BEGIN
  IF to_regclass('ai_model_pricing_refresh_log') IS NOT NULL THEN
    ALTER TABLE ai_model_pricing_refresh_log ADD COLUMN IF NOT EXISTS snapshot_id    BIGINT;
    ALTER TABLE ai_model_pricing_refresh_log ADD COLUMN IF NOT EXISTS page_model_ids JSONB;
    ALTER TABLE ai_model_pricing_refresh_log ADD COLUMN IF NOT EXISTS page_sections  INTEGER;
    ALTER TABLE ai_model_pricing_refresh_log ADD COLUMN IF NOT EXISTS coverage       JSONB;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_model_pricing_refresh_log_snapshot_fk') THEN
      ALTER TABLE ai_model_pricing_refresh_log ADD CONSTRAINT ai_model_pricing_refresh_log_snapshot_fk
        FOREIGN KEY (snapshot_id) REFERENCES ai_model_pricing_page_snapshots(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

COMMENT ON TABLE ai_model_pricing_page_snapshots IS
  'Lot 113O : contenu intégral de la page tarifaire réellement reçue (dédoublonné par empreinte, sans secret).';
