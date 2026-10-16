-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0450 : T3 — harmonisation intelligente du nommage documentaire
-- (lot 61, ticket « [P2] T3 — Harmonisation intelligente du nommage
-- documentaire »).
--
--   document_naming_groups — état de l'examen de chaque LOT DE COMPARAISON
--       du compte (documents comparables : même nature et même émetteur, ou
--       même bien à défaut d'émetteur). Les FAMILLES sont décidées par l'IA à
--       l'intérieur du lot ; aucune nomenclature n'est stockée comme règle :
--       `conventions` mémorise les conventions DÉCRITES par l'IA au dernier
--       examen, redonnées en contexte au suivant (stabilité), jamais
--       appliquées par le code. `fingerprint` = état du lot après le dernier
--       examen complet : à état inchangé, aucun nouvel appel, aucun
--       renommage. `progress` : examen en plusieurs appels (lots volumineux),
--       repris au passage suivant après une interruption. `snapshot` :
--       empreinte de chaque document au dernier examen — dans un lot
--       volumineux, un nouvel import ne fait réexaminer que les documents
--       nouveaux ou modifiés (avec des documents de référence du lot).
--
--   document_rename_events — journal de CHAQUE proposition de renommage et de
--       son issue réelle : APPLIED (écrit en base, dans la même transaction
--       que le nouveau nom), REFUSED (garde-fou), CONFLICT (nom modifié entre
--       l'analyse IA et l'écriture, renommage manuel), NO_CHANGE (nom
--       équivalent), FAILED. L'historique des renommages = lignes APPLIED
--       (ancien nom, nouveau nom, origine, date, justification IA, documents
--       de référence). `idempotency_key` unique : une reprise après
--       interruption ne duplique rien.
--
-- L'ORIGINE du nom en place n'est PAS une colonne d'`asset_files` : elle est
-- dérivée à la lecture (titre utilisateur `title_source = 'USER'`, dernière
-- écriture journalisée — ce journal ou `document_title_events` — dont le nom
-- est TOUJOURS le nom en place, nom du fichier déposé), donc jamais périmée
-- par un autre chemin d'écriture. Un nom sans trace est d'origine INCONNUE
-- (noms historiques) : traité avec prudence par le code (confiance
-- « certain » exigée, garde-fous identiques).
--
-- Tables neuves (vides) : contraintes créées avec la table. Index annexe dans
-- 0450_..._idx_1 (CONCURRENTLY). Idempotente.
-- Retour arrière : DROP TABLE IF EXISTS document_rename_events,
-- document_naming_groups (le code tolère leur absence : phase non exécutée,
-- signalée).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_naming_groups (
  id                BIGSERIAL   PRIMARY KEY,
  account_id        INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  group_key         TEXT        NOT NULL,
  status            TEXT        NOT NULL,
  fingerprint       TEXT,
  document_count    INTEGER     NOT NULL DEFAULT 0,
  progress          JSONB,
  snapshot          JSONB,
  conventions       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  prompt_version    TEXT,
  last_reviewed_at  TIMESTAMPTZ,
  retry_after       TIMESTAMPTZ,
  last_error        TEXT,
  attempts          INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_naming_groups_key_uq UNIQUE (account_id, group_key),
  CONSTRAINT document_naming_groups_status_check CHECK (status IN ('DONE', 'IN_PROGRESS', 'DEFERRED', 'ERROR', 'PROMPT_UNAVAILABLE'))
);

COMMENT ON TABLE document_naming_groups IS
  'Lot 61 : état de l''harmonisation T3 du nommage par lot de documents comparables (empreinte, reprise, conventions décrites par l''IA — jamais un gabarit appliqué par le code).';

CREATE TABLE IF NOT EXISTS document_rename_events (
  id                      BIGSERIAL   PRIMARY KEY,
  account_id              INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id                 INTEGER     NOT NULL,
  group_key               TEXT,
  account_run_id          INTEGER,
  origin                  TEXT        NOT NULL DEFAULT 'T3_HARMONIZATION',
  outcome                 TEXT        NOT NULL,
  reason_code             TEXT,
  old_name                TEXT,
  expected_name           TEXT,
  proposed_name           TEXT,
  applied_name            TEXT,
  reference_document_ids  INTEGER[]   NOT NULL DEFAULT '{}',
  ai_reason               TEXT,
  confidence              TEXT,
  name_origin             TEXT,
  document_fingerprint    TEXT,
  prompt_version          TEXT,
  trace_id                TEXT,
  idempotency_key         TEXT        NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_rename_events_idem_uq UNIQUE (idempotency_key),
  CONSTRAINT document_rename_events_outcome_check CHECK (outcome IN ('APPLIED', 'REFUSED', 'CONFLICT', 'NO_CHANGE', 'FAILED')),
  CONSTRAINT document_rename_events_applied_check CHECK (outcome <> 'APPLIED' OR applied_name IS NOT NULL)
);

COMMENT ON TABLE document_rename_events IS
  'Lot 61 : propositions de renommage T3 (harmonisation documentaire) et issue réelle. Historique des renommages = lignes APPLIED (ancien / nouveau nom, origine, date, justification).';
