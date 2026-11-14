-- ─────────────────────────────────────────────────────────────────────────
-- Migration 1710 : IA — mémoire PARTAGÉE et DURABLE de la compatibilité des
-- schémas de sortie transmis au fournisseur (lot 114, carte Trello #776
-- « IA T1 / Gateway — Schémas Gemini compatibles, conservation exhaustive et
-- contrôle de couverture », cahier des charges §5).
--
-- Avant : le refus d'un schéma par le fournisseur (HTTP 400) n'était retenu
-- que dans la mémoire du processus, 6 heures (`noteSchemaRejected`) — perdu
-- au redémarrage, inconnu des autres instances, qui repayaient chacune le
-- refus puis le nouvel essai sans schéma.
--
-- `ai_schema_compatibility` : UNE ligne par couple réellement transmis —
-- fournisseur, modèle, opération, contrat runtime (identifiant, version,
-- empreinte), schéma fournisseur projeté (empreinte), version de
-- l'adaptateur de projection. Un changement de modèle, de contrat, de schéma
-- projeté ou d'adaptateur donne une AUTRE clé : l'ancienne qualification ne
-- s'applique plus (elle reste lisible, historique).
--
--   state                   NOT_TESTED | QUALIFIED | REJECTED_CONFIRMED |
--                           NEEDS_RECHECK | UNSUPPORTED_BY_CONTRACT ;
--   reason_code             motif du dernier état (refus explicite du schéma,
--                           400 générique levé par l'essai sans schéma,
--                           acceptation d'un appel réel, motif statique) ;
--   next_retest_at          prochain essai AVEC schéma au plus tôt ;
--   retest_claimed_until    réservation de cet essai par UNE instance
--                           (les autres continuent sans schéma : pas de rafale) ;
--   policy_version          version de la politique de réexamen appliquée.
--
-- Aucun contenu de document, de prompt ni de schéma : empreintes,
-- identifiants, versions, compteurs et dates. Aucune donnée de compte.
--
-- IDEMPOTENTE et NON DESTRUCTIVE : CREATE TABLE / INDEX IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_schema_compatibility (
  id                      BIGSERIAL PRIMARY KEY,
  -- Clé stable du couple (empreinte des colonnes d'identité ci-dessous).
  key_id                  TEXT        NOT NULL,
  provider                TEXT        NOT NULL,
  model                   TEXT        NOT NULL,
  operation_code          TEXT        NOT NULL,
  contract_id             TEXT        NOT NULL,
  contract_version        INTEGER     NOT NULL,
  -- Empreinte du contrat runtime canonique.
  schema_hash             TEXT        NOT NULL,
  -- Empreinte du schéma fournisseur projeté ('-' : aucun schéma transmissible).
  provider_schema_hash    TEXT        NOT NULL,
  adapter_version         TEXT        NOT NULL,
  state                   TEXT        NOT NULL DEFAULT 'NOT_TESTED',
  reason_code             TEXT,
  accepted_count          INTEGER     NOT NULL DEFAULT 0,
  rejection_count         INTEGER     NOT NULL DEFAULT 0,
  consecutive_rejections  INTEGER     NOT NULL DEFAULT 0,
  retest_count            INTEGER     NOT NULL DEFAULT 0,
  first_rejected_at       TIMESTAMPTZ,
  last_rejected_at        TIMESTAMPTZ,
  last_accepted_at        TIMESTAMPTZ,
  next_retest_at          TIMESTAMPTZ,
  retest_claimed_until    TIMESTAMPTZ,
  last_http_status        INTEGER,
  last_provider_code      TEXT,
  policy_version          INTEGER     NOT NULL DEFAULT 1,
  app_version             TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_schema_compatibility_key_idx
  ON ai_schema_compatibility (key_id);

CREATE INDEX IF NOT EXISTS ai_schema_compatibility_couple_idx
  ON ai_schema_compatibility (operation_code, model, updated_at DESC);

COMMENT ON TABLE ai_schema_compatibility IS
  'Compatibilité des schémas de sortie transmis au fournisseur IA, par couple fournisseur / modèle / opération / contrat / '
  'schéma projeté / adaptateur : état, motif, réexamen borné et réservé — lot 114, carte #776. Empreintes et compteurs '
  'seulement : aucun contenu, aucun secret, aucune donnée de compte.';
