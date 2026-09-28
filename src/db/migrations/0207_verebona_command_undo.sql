-- =============================================================================
-- 0207 — « Annuler » une action exécutée depuis l'assistant (CDC BO IA T2-038,
-- T2-039 ; CDC Assistant §5.3 « possibilité d'annulation lorsque le métier le
-- permet »).
--
-- Décision produit : l'annulation reste proposée 15 minutes après
-- l'exécution, pour les seules actions RÉVERSIBLES (créations et
-- modifications simples). Aucun bouton dès qu'une étape du plan est
-- irréversible (synchronisation échéance → bien, effet externe…).
--
-- `verebona_command_undo_steps` : pour chaque étape réversible exécutée, la
-- commande inverse à appliquer et l'état ANTÉRIEUR de la cible (valeurs
-- précédentes), avec l'empreinte de la cible juste avant et juste après
-- l'exécution. L'annulation n'est appliquée que si la cible porte toujours
-- l'empreinte « après » (contrôle optimiste : rien n'a été modifié depuis).
--
-- `verebona_command_plans.undo_until` : fin de la fenêtre d'annulation ; NULL
-- = plan non annulable (irréversible, ou rien d'exécuté).
-- `undone_at` : horodatage de l'annulation effective ; le plan passe à
-- l'état UNDONE.
--
-- Idempotente : IF NOT EXISTS partout, contrainte d'état recréée.
-- =============================================================================
ALTER TABLE verebona_command_plans ADD COLUMN IF NOT EXISTS undo_until TIMESTAMPTZ;
ALTER TABLE verebona_command_plans ADD COLUMN IF NOT EXISTS undone_at TIMESTAMPTZ;

ALTER TABLE verebona_command_plans DROP CONSTRAINT IF EXISTS verebona_command_plans_status_check;
ALTER TABLE verebona_command_plans ADD CONSTRAINT verebona_command_plans_status_check CHECK (status IN (
  'PENDING_CONFIRMATION', 'EXECUTING', 'EXECUTED', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUSED', 'UNDONE'));

CREATE TABLE IF NOT EXISTS verebona_command_undo_steps (
  id              SERIAL PRIMARY KEY,
  plan_id         TEXT        NOT NULL,
  account_id      INTEGER     NOT NULL,
  user_id         INTEGER     NOT NULL,
  action_id       TEXT        NOT NULL,
  command         TEXT        NOT NULL,
  target_type     TEXT        NOT NULL,
  target_id       INTEGER     NOT NULL,
  -- Commande inverse : DELETE_AGENDA_ITEM, RESTORE_AGENDA_STATUS, RESTORE_ASSET_FIELDS.
  inverse_op      TEXT        NOT NULL,
  -- Valeurs de la cible AVANT l'exécution (vide pour une création).
  before_json     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  version_before  TEXT,
  version_after   TEXT        NOT NULL,
  label           TEXT        NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at       TIMESTAMPTZ,
  CONSTRAINT verebona_command_undo_steps_uniq UNIQUE (plan_id, action_id),
  CONSTRAINT verebona_command_undo_steps_inverse_check CHECK (inverse_op IN (
    'DELETE_AGENDA_ITEM', 'RESTORE_AGENDA_STATUS', 'RESTORE_ASSET_FIELDS'))
);
CREATE INDEX IF NOT EXISTS verebona_command_undo_steps_plan_idx
  ON verebona_command_undo_steps (plan_id);
CREATE INDEX IF NOT EXISTS verebona_command_undo_steps_account_idx
  ON verebona_command_undo_steps (account_id);

-- ── Clés étrangères : RGPD, suppression de compte ─────────────────────────
-- Les étapes contiennent des valeurs de fiches (caractéristiques d'un bien) :
-- elles disparaissent avec leur plan, leur compte ET leur utilisateur.
--   · plan_id    → verebona_command_plans(plan_id)  (clé TEXT du plan)
--   · account_id → accounts(id)  : suppression du compte entier (J+30) ;
--   · user_id    → users(id)     : suppression « utilisateur seul » (le
--     membre quitte un Duo) — ses étapes dans l'espace du titulaire, dont le
--     compte survit, partent avec lui.
-- Orphelins supprimés d'abord ; contraintes ajoutées une seule fois.
DO $$
BEGIN
  DELETE FROM verebona_command_undo_steps s
   WHERE NOT EXISTS (SELECT 1 FROM verebona_command_plans p WHERE p.plan_id = s.plan_id);
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verebona_command_undo_steps_plan_fk') THEN
    ALTER TABLE verebona_command_undo_steps
      ADD CONSTRAINT verebona_command_undo_steps_plan_fk
      FOREIGN KEY (plan_id) REFERENCES verebona_command_plans(plan_id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('accounts') IS NOT NULL THEN
    DELETE FROM verebona_command_undo_steps s
     WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = s.account_id);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verebona_command_undo_steps_account_fk') THEN
      ALTER TABLE verebona_command_undo_steps
        ADD CONSTRAINT verebona_command_undo_steps_account_fk
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
    END IF;
  END IF;

  IF to_regclass('users') IS NOT NULL THEN
    DELETE FROM verebona_command_undo_steps s
     WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verebona_command_undo_steps_user_fk') THEN
      ALTER TABLE verebona_command_undo_steps
        ADD CONSTRAINT verebona_command_undo_steps_user_fk
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS verebona_command_undo_steps_user_idx
  ON verebona_command_undo_steps (user_id);

-- Purge des états antérieurs dont la fenêtre est close (plans annulables).
CREATE INDEX IF NOT EXISTS verebona_command_plans_undo_until_idx
  ON verebona_command_plans (undo_until)
  WHERE undo_until IS NOT NULL;
