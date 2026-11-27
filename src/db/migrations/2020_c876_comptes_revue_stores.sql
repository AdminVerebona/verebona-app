-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 2020 : COMPTES DE REVUE APPLE / GOOGLE (carte Trello #876, P1 pré-MEP).
--
--   · `accounts.app_review_kind` : qualification technique EXPLICITE du compte,
--     indépendante de l'offre — NULL = « Compte client » (DÉFAUT, tous les
--     comptes existants), 'APPLE' = « Compte de revue Apple », 'GOOGLE' =
--     « Compte de revue Google ». Colonne DISTINCTE de `technical_kind`
--     (lot 103G) : celle-ci est unique par valeur (index 0960) et lue par la
--     logique du corpus IA ; un compte de revue n'est pas un compte technique
--     de qualification. Posée uniquement par BO (SUPER_ADMIN, preuve forte).
--
--   · `app_review_mfa_exemptions` : identités AUTORISÉES à bénéficier de
--     l'exemption de l'obligation GLOBALE de double authentification, une
--     ligne par autorisation (motif, auteur, date), révocable (date, auteur,
--     motif). Au plus UNE autorisation active par identité. Aucune ligne =
--     aucune exemption (défaut). La ligne seule ne suffit pas : la décision
--     (`lib/auth/mfa/app-review.ts`) revérifie à chaque requête le rôle, le
--     statut, la qualification et les appartenances (fail closed).
--
--   · `app_review_events` : historique auditable (qualification, retrait,
--     autorisation, révocation, droits de démonstration) — jamais un secret.
--
-- Additive, idempotente, rejouable, NON DESTRUCTIVE : aucune donnée existante
-- réécrite, comptes clients inchangés (colonne NULL). Retour arrière :
-- DROP TABLE app_review_events, app_review_mfa_exemptions ;
-- ALTER TABLE accounts DROP COLUMN app_review_kind — le code détecte
-- l'absence (42P01 / 42703) et n'accorde alors AUCUNE exemption.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS app_review_kind TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'accounts'::regclass AND conname = 'accounts_app_review_kind_chk') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_app_review_kind_chk
      CHECK (app_review_kind IS NULL OR app_review_kind IN ('APPLE', 'GOOGLE')) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN accounts.app_review_kind IS
  'Carte #876 : NULL = compte client (défaut) ; APPLE / GOOGLE = compte de revue des stores. Posé uniquement par un SUPER_ADMIN au BO (preuve forte, motif, historique app_review_events).';

CREATE TABLE IF NOT EXISTS app_review_mfa_exemptions (
  id             SERIAL      PRIMARY KEY,
  user_id        INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id     INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  granted_by     INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  granted_reason TEXT        NOT NULL,
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ,
  revoked_by     INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  revoked_reason TEXT,
  CONSTRAINT app_review_mfa_exemptions_reason_chk CHECK (length(btrim(granted_reason)) > 0),
  CONSTRAINT app_review_mfa_exemptions_revoke_chk CHECK (revoked_at IS NULL OR revoked_reason IS NOT NULL)
);
-- Au plus une autorisation ACTIVE par identité (lecture de la décision MFA).
CREATE UNIQUE INDEX IF NOT EXISTS app_review_mfa_exemptions_active_uniq
  ON app_review_mfa_exemptions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS app_review_mfa_exemptions_account_idx
  ON app_review_mfa_exemptions (account_id);

COMMENT ON TABLE app_review_mfa_exemptions IS
  'Carte #876 : identités autorisées (SUPER_ADMIN) à être exemptées de l''obligation GLOBALE de MFA sur un compte de revue Apple / Google. Un facteur enrôlé reste toujours exigé.';

CREATE TABLE IF NOT EXISTS app_review_events (
  id          BIGSERIAL   PRIMARY KEY,
  account_id  INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  event       TEXT        NOT NULL,
  review_kind TEXT,
  reason      TEXT,
  actor_id    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_review_events_event_chk CHECK (event IN (
    'ACCOUNT_QUALIFIED', 'ACCOUNT_UNQUALIFIED', 'EXEMPTION_GRANTED', 'EXEMPTION_REVOKED', 'DEMO_RIGHTS_GRANTED'
  ))
);
CREATE INDEX IF NOT EXISTS app_review_events_account_idx
  ON app_review_events (account_id, created_at DESC);

COMMENT ON TABLE app_review_events IS
  'Carte #876 : historique des comptes de revue (qualification, exemptions MFA, droits de démonstration) — auteur, date, motif ; aucun secret.';
