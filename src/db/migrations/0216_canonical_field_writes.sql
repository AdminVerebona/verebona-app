-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0216 : journal des écritures canoniques — CDC 15 §12 (SVC-05),
-- T3-01, T3-02, T3-05, T2-38, DOD-18/19. Plan lot 11, décision D-10.
--
-- Chaque appel de `writeCanonicalAssetField()` laisse UNE ligne par clé
-- canonique, quel que soit l'appelant (fiche, assistant, T3, import, admin) :
--
--   canonical_key            clé du registre canonique (jamais un alias) ;
--   old_value / new_value    valeurs canoniques sérialisées en JSON (euros
--                            pour les montants, D-09 ; dates AAAA-MM-JJ) ;
--   origin                   USER | ADMIN | DOCUMENT_EXTRACTION |
--                            RECONCILIATION | IMPORT | SYSTEM_RULE ;
--   actor_user_id            utilisateur à l'origine de l'écriture humaine ;
--   source_type / source_id  provenance (asset_details, assistant_command,
--                            document, reconciliation…) ;
--   trace_id                 corrélation avec les traces IA / requêtes ;
--   outcome                  written | unchanged | protected | invalid |
--                            conflict (écriture refusée ou sans effet) ;
--   dry_run                  true en mode `shadow` : rien n'a été écrit par la
--                            primitive, la ligne décrit ce qu'elle AURAIT fait ;
--   divergence               en mode `shadow`, écart entre l'état produit par
--                            le chemin historique et l'état calculé (valeur,
--                            origine, colonnes miroir) ; NULL sinon ;
--   mirror_columns           colonnes historiques recopiées (D-10).
--
-- Portée compte : cascade à la suppression du compte et du bien. L'utilisateur
-- supprimé laisse la ligne (actor_user_id → NULL).
--
-- Idempotente : IF NOT EXISTS partout, contraintes supprimées puis recréées.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS canonical_field_writes (
  id              bigserial PRIMARY KEY,
  account_id      integer     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id        integer     NOT NULL REFERENCES assets(id)   ON DELETE CASCADE,
  canonical_key   text        NOT NULL,
  old_value       jsonb,
  new_value       jsonb,
  origin          text        NOT NULL,
  actor_user_id   integer     REFERENCES users(id) ON DELETE SET NULL,
  source_type     text,
  source_id       text,
  trace_id        text,
  outcome         text        NOT NULL DEFAULT 'written',
  dry_run         boolean     NOT NULL DEFAULT false,
  divergence      jsonb,
  mirror_columns  jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Colonnes ajoutées après une première version locale de la table.
ALTER TABLE canonical_field_writes ADD COLUMN IF NOT EXISTS outcome        text NOT NULL DEFAULT 'written';
ALTER TABLE canonical_field_writes ADD COLUMN IF NOT EXISTS divergence     jsonb;
ALTER TABLE canonical_field_writes ADD COLUMN IF NOT EXISTS mirror_columns jsonb;

ALTER TABLE canonical_field_writes DROP CONSTRAINT IF EXISTS canonical_field_writes_origin_check;
ALTER TABLE canonical_field_writes ADD CONSTRAINT canonical_field_writes_origin_check CHECK (
  origin IN ('USER', 'ADMIN', 'DOCUMENT_EXTRACTION', 'RECONCILIATION', 'IMPORT', 'SYSTEM_RULE')
);

ALTER TABLE canonical_field_writes DROP CONSTRAINT IF EXISTS canonical_field_writes_outcome_check;
ALTER TABLE canonical_field_writes ADD CONSTRAINT canonical_field_writes_outcome_check CHECK (
  outcome IN ('written', 'unchanged', 'protected', 'invalid', 'conflict')
);

-- Historique d'un champ d'un bien (fiche, assistant, audit).
CREATE INDEX IF NOT EXISTS canonical_field_writes_asset_key_idx
  ON canonical_field_writes (asset_id, canonical_key, created_at DESC);
-- Purge et export RGPD par compte.
CREATE INDEX IF NOT EXISTS canonical_field_writes_account_idx
  ON canonical_field_writes (account_id, created_at DESC);
-- Rapport d'observation (mode shadow) : divergences seulement.
CREATE INDEX IF NOT EXISTS canonical_field_writes_divergence_idx
  ON canonical_field_writes (created_at DESC) WHERE dry_run AND divergence IS NOT NULL;
CREATE INDEX IF NOT EXISTS canonical_field_writes_trace_idx
  ON canonical_field_writes (trace_id) WHERE trace_id IS NOT NULL;

COMMENT ON TABLE canonical_field_writes IS
  'Journal de writeCanonicalAssetField (CDC 15 SVC-05) : une ligne par clé canonique écrite, refusée ou observée (dry_run).';
COMMENT ON COLUMN canonical_field_writes.dry_run IS
  'Mode CANONICAL_WRITE_MODE=shadow : la primitive n''a rien écrit ; divergence décrit l''écart avec le chemin historique.';
