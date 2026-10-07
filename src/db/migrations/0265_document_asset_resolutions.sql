-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0265 : rattachement Document → Bien non résolu par T1 — état de la
-- réconciliation T3 DOCUMENT_ASSET (lot 31B).
--
-- document_asset_resolutions — UNE ligne par document : où en est la reprise
-- par T3 d'un document que T1 n'a pas pu rattacher avec certitude.
--   · status            PENDING (travail T3 en file) | RESOLVED (bien
--                       principal posé par T3) | MULTI_ASSET (document
--                       réellement multi-biens : biens liés en SECONDARY,
--                       aucun principal forcé) | ABSTAINED (T3 n'a pas pu
--                       départager : « À traiter » ouvert avec les candidats)
--                       | NO_CANDIDATE (aucun bien candidat : « À traiter »
--                       À compléter) | USER_DECIDED (l'utilisateur a décidé
--                       entre-temps) | ALREADY_LINKED (rattaché par un autre
--                       chemin) | TARGET_GONE (document supprimé) ;
--   · last_outcome      dernière issue terminale (le statut repasse PENDING à
--                       chaque nouvelle demande ; l'issue, elle, reste lue
--                       pour l'idempotence) ;
--   · method            DETERMINISTIC (identifiant canonique exact, sans
--                       appel modèle) | AI (prompt maître T3, relation
--                       DOCUMENT_ASSET) | NONE ;
--   · t1_candidates     candidats et preuves produits par T1 (identifiants
--                       de biens, confiance, score, signaux) — T3 travaille
--                       sur eux, jamais sur le fichier ;
--   · candidates        candidats présentés à l'utilisateur après abstention ;
--   · decided_asset_ids biens rattachés par T3 ;
--   · input_fingerprint empreinte des entrées (idempotence : une relance sur
--                       les mêmes entrées ne rappelle pas le modèle) ;
--   · extraction_at     représentation T1 (`document_extractions.updated_at`)
--                       sur laquelle T3 a statué : une nouvelle analyse rend
--                       la ligne obsolète (rattrapage horaire).
-- Le balayage horaire T3 lit cette table pour ne relancer que les documents
-- sans bien principal, sans travail en cours et sans décision définitive.
--
-- Rattrapage des données existantes : aucun SQL ici — le passage planifié T3
-- reprend le stock (documents analysés sans bien principal) par lots bornés.
--
-- Rétrocompatible : table nouvelle ; l'ancien code l'ignore.
-- Retour arrière : DROP TABLE document_asset_resolutions (aucune table ne la
-- référence).
-- Idempotente : IF NOT EXISTS. Index de la table neuve (vide) créés ici ;
-- l'index sur asset_files (table existante) est dans 0265_…_idx_1
-- (CONCURRENTLY, optionnel).
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_asset_resolutions (
  file_id            INTEGER     PRIMARY KEY REFERENCES asset_files(id) ON DELETE CASCADE,
  account_id         INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status             TEXT        NOT NULL,
  last_outcome       TEXT,
  method             TEXT,
  reason_code        TEXT,
  t1_candidates      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  candidates         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  decided_asset_ids  INTEGER[]   NOT NULL DEFAULT '{}',
  input_fingerprint  TEXT,
  extraction_at      TIMESTAMPTZ,
  trigger_code       TEXT,
  runs               INTEGER     NOT NULL DEFAULT 0,
  requested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_asset_resolutions_status_chk CHECK (status IN (
    'PENDING', 'RESOLVED', 'MULTI_ASSET', 'ABSTAINED', 'NO_CANDIDATE',
    'USER_DECIDED', 'ALREADY_LINKED', 'TARGET_GONE')),
  CONSTRAINT document_asset_resolutions_method_chk CHECK (method IS NULL OR method IN ('DETERMINISTIC', 'AI', 'NONE'))
);

CREATE INDEX IF NOT EXISTS document_asset_resolutions_account_status_idx
  ON document_asset_resolutions (account_id, status);
