-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0304 : catalogue TARIFAIRE synchronisé et historisé
-- Lot 35B, ticket « Catalogue IA dynamique Google : modèles, tarifs, Preview et
-- alertes BO ».
--
-- Catalogue modèles (0177/0303) et catalogue tarifs sont SÉPARÉS : Google ne
-- publie pas les prix dans `models.list`. Les tarifs viennent de la page
-- officielle (https://ai.google.dev/gemini-api/docs/pricing, export
-- Markdown), lue par un adaptateur isolé et testé.
--
-- ai_model_price_status : état COURANT par modèle — KNOWN (montants, paliers,
--   devise, source, date de récupération, date de dernière modification) ou
--   UNKNOWN (raison : absent de la page, ambiguïté…). Jamais de montant
--   inventé : UNKNOWN n'a pas de montant.
-- ai_model_price_changes : HISTORIQUE des changements (ancienne valeur,
--   nouvelle valeur, date de détection).
-- ai_model_pricing (0111) : tarifs servis au calcul des coûts, inchangés dans
--   leur principe (une ligne par tarif, `effective_from`). Ajouts :
--   · `tiers` : paliers (ex. au-delà de 200 000 jetons d'invite) ;
--   · `invalidated_at` : tarif retiré parce que sa correspondance avec le
--     modèle n'est plus certaine (le coût devient « non calculable »).
--   Les coûts PASSÉS sont figés dans chaque trace au moment de l'appel : ni un
--   changement ni un retrait de tarif ne les revalorise.
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_model_price_status (
  provider            TEXT        NOT NULL,
  model               TEXT        NOT NULL,
  status              TEXT        NOT NULL,
  input_per_million   NUMERIC(20, 6),
  output_per_million  NUMERIC(20, 6),
  tiers               JSONB,
  currency            TEXT,
  source              TEXT        NOT NULL,
  source_url          TEXT,
  reason              TEXT,
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_changed_at     TIMESTAMPTZ,
  PRIMARY KEY (provider, model),
  CONSTRAINT ai_model_price_status_check CHECK (status IN ('KNOWN', 'UNKNOWN')),
  CONSTRAINT ai_model_price_status_amounts_check CHECK (
    (status = 'KNOWN' AND input_per_million IS NOT NULL AND output_per_million IS NOT NULL)
    OR (status = 'UNKNOWN' AND input_per_million IS NULL AND output_per_million IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS ai_model_price_changes (
  id                  BIGSERIAL   PRIMARY KEY,
  provider            TEXT        NOT NULL,
  model               TEXT        NOT NULL,
  old_status          TEXT,
  new_status          TEXT        NOT NULL,
  old_input           NUMERIC(20, 6),
  old_output          NUMERIC(20, 6),
  old_tiers           JSONB,
  new_input           NUMERIC(20, 6),
  new_output          NUMERIC(20, 6),
  new_tiers           JSONB,
  currency            TEXT,
  source              TEXT        NOT NULL,
  reason              TEXT,
  detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ai_model_pricing ADD COLUMN IF NOT EXISTS tiers          JSONB;
ALTER TABLE ai_model_pricing ADD COLUMN IF NOT EXISTS invalidated_at TIMESTAMPTZ;

COMMENT ON TABLE ai_model_price_status IS
  'Tarif courant par modèle, synchronisé depuis la page officielle Google (KNOWN | UNKNOWN, jamais inventé) — lot 35B.';
COMMENT ON TABLE ai_model_price_changes IS
  'Historique des changements de tarif (ancienne / nouvelle valeur, date de détection). Les coûts passés ne sont jamais revalorisés.';
