-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0172 — Back-office V1 : anomalies de supervision.
--
-- CDC Back-Office V1 §4.5 (SUP-001 à SUP-012, SUP-H01/H02) :
--   - une anomalie n'est créée qu'après échec des retries (SUP-009), par le
--     code applicatif (aucune création manuelle, SUP-012) ;
--   - les occurrences d'une même anomalie OUVERTE sont consolidées : une seule
--     ligne par empreinte ouverte (index unique partiel), compteur, première
--     et dernière occurrence, historique dans `admin_anomaly_occurrences`
--     (SUP-010) ;
--   - une anomalie résolue qui réapparaît crée une NOUVELLE ligne liée à la
--     précédente par `previous_anomaly_id` (SUP-011) ;
--   - résolution manuelle (journalisée, AUD-003) ou automatique avec date,
--     source et cause technique connue (SUP-008) ;
--   - aucune criticité (§4.5 : « ne comporte aucun niveau de criticité »).
--
-- Idempotente : peut être rejouée sans effet.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS admin_anomalies (
  id                   SERIAL PRIMARY KEY,
  -- Domaine supervisé (SUP-004). Liste fermée : un nouveau domaine doit être
  -- ajouté ici ET dans `ANOMALY_DOMAINS` (services/admin/anomaly.service.ts).
  domain               TEXT        NOT NULL,
  -- Empreinte de consolidation : « même anomalie » = même empreinte.
  fingerprint          TEXT        NOT NULL,
  title                TEXT        NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'open',
  account_id           INTEGER     REFERENCES accounts(id) ON DELETE SET NULL,
  user_id              INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  -- Détail technique de la DERNIÈRE occurrence (les précédentes sont dans
  -- l'historique des occurrences).
  technical_detail     JSONB,
  occurrence_count     INTEGER     NOT NULL DEFAULT 1,
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Saisies de traitement (SUP-007).
  cause                TEXT,
  internal_comment     TEXT,
  corrective_action    TEXT,
  -- Résolution (SUP-007 manuelle, SUP-008 automatique).
  resolved_at          TIMESTAMPTZ,
  resolved_by          INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  resolution_source    TEXT,
  -- Résolution automatique : mécanisme ayant constaté le retour à la normale
  -- (ex. « stripe_webhook_retry ») et cause technique connue.
  auto_resolution_origin TEXT,
  auto_resolution_cause  TEXT,
  -- Récurrence (SUP-011).
  previous_anomaly_id  INTEGER     REFERENCES admin_anomalies(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE admin_anomalies DROP CONSTRAINT IF EXISTS admin_anomalies_domain_check;
ALTER TABLE admin_anomalies ADD CONSTRAINT admin_anomalies_domain_check CHECK (domain IN (
  'stripe', 'communications', 'exports', 'backups', 'ai', 'referrals', 'other'
));

ALTER TABLE admin_anomalies DROP CONSTRAINT IF EXISTS admin_anomalies_status_check;
ALTER TABLE admin_anomalies ADD CONSTRAINT admin_anomalies_status_check
  CHECK (status IN ('open', 'resolved'));

ALTER TABLE admin_anomalies DROP CONSTRAINT IF EXISTS admin_anomalies_resolution_check;
ALTER TABLE admin_anomalies ADD CONSTRAINT admin_anomalies_resolution_check CHECK (
  (status = 'open' AND resolved_at IS NULL AND resolution_source IS NULL)
  OR (status = 'resolved' AND resolved_at IS NOT NULL AND resolution_source IN ('manual', 'auto'))
);

-- SUP-010 : au plus UNE anomalie ouverte par empreinte. C'est ce qui rend la
-- consolidation sûre face à deux échecs simultanés.
CREATE UNIQUE INDEX IF NOT EXISTS admin_anomalies_open_fingerprint_uidx
  ON admin_anomalies (fingerprint) WHERE status = 'open';

-- Récurrence : dernière anomalie résolue d'une empreinte.
CREATE INDEX IF NOT EXISTS admin_anomalies_fingerprint_resolved_idx
  ON admin_anomalies (fingerprint, resolved_at DESC) WHERE status = 'resolved';

-- Compteurs par domaine et listes (ouvertes / historique).
CREATE INDEX IF NOT EXISTS admin_anomalies_status_domain_idx ON admin_anomalies (status, domain);
CREATE INDEX IF NOT EXISTS admin_anomalies_status_last_seen_idx ON admin_anomalies (status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS admin_anomaly_occurrences (
  id               SERIAL PRIMARY KEY,
  anomaly_id       INTEGER     NOT NULL REFERENCES admin_anomalies(id) ON DELETE CASCADE,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  account_id       INTEGER     REFERENCES accounts(id) ON DELETE SET NULL,
  user_id          INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  technical_detail JSONB
);

CREATE INDEX IF NOT EXISTS admin_anomaly_occurrences_anomaly_idx
  ON admin_anomaly_occurrences (anomaly_id, occurred_at DESC);
