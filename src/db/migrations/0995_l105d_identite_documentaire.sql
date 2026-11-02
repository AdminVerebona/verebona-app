-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0995 : GROUPES D'IDENTITÉ DOCUMENTAIRE et DÉCISIONS de
-- l'utilisateur sur ces groupes (lot 105D, ticket « T3 / Cohérence /
-- À traiter — Rattachement rétroactif après création d'un bien », §D4, §F).
--
-- `document_identity_groups` : JOURNAL / instantané (supervision, carte
-- groupée) du dernier état calculé d'un groupe de documents qui désignent une
-- même identité de bien (adresse au rôle « bien », cadastre, immatriculation,
-- VIN). Recalculé depuis la connaissance PERSISTÉE à chaque passage T3 du
-- compte : ce n'est PAS une source métier (la vérité reste
-- `document_asset_links`, `document_asset_resolutions`, faits T1). Versionné
-- (`engine_version`), empreinte (`fingerprint`), membres, ancres, exclus et
-- motifs, provenance des arêtes (références de signaux, rôles, champs — jamais
-- de contenu de document), contradictions, statut face aux biens, carte.
-- `identity_label` : adresse lue (affichée sur la carte « À traiter »),
-- donnée sensible — omise du diagnostic (security.ts).
--
-- `document_identity_decisions` : décision DURABLE et prioritaire de
-- l'utilisateur « ce logement est (CONFIRMED) / n'est pas (REFUSED) mon bien
-- X ». Une seule décision ACTIVE par (compte, groupe, bien) ; une annulation
-- ou une nouvelle décision la passe SUPERSEDED / UNDONE avec son motif
-- (traçabilité des invalidations). `context_fingerprint` : identité du bien au
-- moment de la décision (un refus reste valable tant qu'elle ne change pas).
--
-- Additive, idempotente, aucune reprise de données (le premier passage T3 de
-- chaque compte remplit les groupes). Tables neuves : index créés en ligne.
-- Retour arrière : T3_IDENTITY_GROUPS_ENABLED=0 (T3 se comporte comme avant
-- le lot 105D), puis éventuellement DROP TABLE IF EXISTS des deux tables.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_identity_groups (
  id                   BIGSERIAL   PRIMARY KEY,
  account_id           INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  group_key            TEXT        NOT NULL,
  identity_family      TEXT        NOT NULL,
  identity_kinds       TEXT[]      NOT NULL DEFAULT '{}',
  identity_label       TEXT,
  engine_version       INTEGER     NOT NULL,
  fingerprint          TEXT        NOT NULL,
  status               TEXT        NOT NULL,
  member_file_ids      INTEGER[]   NOT NULL DEFAULT '{}',
  anchor_file_ids      INTEGER[]   NOT NULL DEFAULT '{}',
  members              JSONB       NOT NULL DEFAULT '[]'::jsonb,
  excluded             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  edges                JSONB       NOT NULL DEFAULT '[]'::jsonb,
  evidence             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  contradictions       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  target_asset_id      INTEGER,
  candidate_asset_ids  INTEGER[]   NOT NULL DEFAULT '{}',
  refused_asset_ids    INTEGER[]   NOT NULL DEFAULT '{}',
  card_action_id       INTEGER,
  active               BOOLEAN     NOT NULL DEFAULT true,
  last_evaluation      JSONB,
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  evaluated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_identity_groups_family_chk CHECK (identity_family IN ('PROPERTY', 'VEHICLE')),
  CONSTRAINT document_identity_groups_status_chk CHECK (status IN ('DEMONSTRABLE', 'ATTESTED', 'CONFIRMED', 'TO_CONFIRM', 'REFUSED', 'AMBIGUOUS', 'NO_CANDIDATE'))
);
CREATE UNIQUE INDEX IF NOT EXISTS document_identity_groups_key_uidx ON document_identity_groups (account_id, group_key);

CREATE TABLE IF NOT EXISTS document_identity_decisions (
  id                   BIGSERIAL   PRIMARY KEY,
  account_id           INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  group_key            TEXT        NOT NULL,
  asset_id             INTEGER     NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  decision             TEXT        NOT NULL,
  context_fingerprint  TEXT        NOT NULL,
  group_fingerprint    TEXT,
  member_file_ids      INTEGER[]   NOT NULL DEFAULT '{}',
  decided_by_user_id   INTEGER,
  action_id            INTEGER,
  status               TEXT        NOT NULL DEFAULT 'ACTIVE',
  superseded_reason    TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at        TIMESTAMPTZ,
  CONSTRAINT document_identity_decisions_decision_chk CHECK (decision IN ('CONFIRMED', 'REFUSED')),
  CONSTRAINT document_identity_decisions_status_chk CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'UNDONE'))
);
CREATE UNIQUE INDEX IF NOT EXISTS document_identity_decisions_active_uidx
  ON document_identity_decisions (account_id, group_key, asset_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS document_identity_decisions_asset_idx ON document_identity_decisions (asset_id);
