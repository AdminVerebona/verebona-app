-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0116 — Suppression planifiée de compte
--
-- CDC rétractation §13.3 : « à la confirmation, créer
-- data_deletion_scheduled_at = confirmed_at + 30 jours », avec rappels à sept
-- jours et vingt-quatre heures, et annulation automatique si une nouvelle
-- souscription est conclue.
--
-- ── POURQUOI UNE TABLE ET NON UNE COLONNE SUR `accounts` ──────────────────
--
-- Une colonne `data_deletion_scheduled_at` aurait suffi à porter la date. Elle
-- n'aurait porté ni le motif, ni les rappels déjà envoyés, ni l'historique des
-- annulations — or le §17 exige de journaliser « date de suppression planifiée
-- et effective », et le §21 fait de l'absence de suppression à l'échéance une
-- anomalie à détecter. Sans trace, cette détection est impossible.
--
-- Une table permet aussi qu'une suppression annulée reste visible : un compte
-- qui a frôlé la suppression puis souscrit à nouveau est une information utile,
-- que l'écrasement d'une colonne aurait effacée.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS scheduled_account_deletions (
  id                  SERIAL      PRIMARY KEY,
  account_id          INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Titulaire au moment de la planification. Conservé même si le compte change
  -- de main : c'est lui qui reçoit les rappels.
  user_id             INTEGER     REFERENCES users(id) ON DELETE SET NULL,

  reason              TEXT        NOT NULL,
  -- Instant de référence : confirmation de la rétractation, ou de la demande.
  confirmed_at        TIMESTAMPTZ NOT NULL,
  -- confirmed_at + 30 jours, calculé à l'écriture et jamais recalculé ensuite.
  scheduled_at        TIMESTAMPTZ NOT NULL,

  status              TEXT        NOT NULL DEFAULT 'SCHEDULED',
  cancelled_at        TIMESTAMPTZ,
  cancellation_reason TEXT,
  executed_at         TIMESTAMPTZ,
  failure_reason      TEXT,

  -- Rappels du §13.3. Horodatés plutôt que booléens : un rappel manquant se
  -- distingue ainsi d'un rappel envoyé au mauvais moment.
  reminder_j7_sent_at  TIMESTAMPTZ,
  reminder_j1_sent_at  TIMESTAMPTZ,
  initial_email_sent_at TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT scheduled_deletions_reason_check CHECK (reason IN (
    'WITHDRAWAL',        -- rétractation confirmée (§13.3)
    'VOLUNTARY',         -- demande explicite du titulaire
    'TRIAL_ABANDONED'    -- essai expiré sans souscription
  )),
  CONSTRAINT scheduled_deletions_status_check CHECK (status IN (
    'SCHEDULED', 'CANCELLED', 'EXECUTED', 'FAILED'
  )),
  -- Une suppression exécutée porte forcément sa date, et réciproquement.
  CONSTRAINT scheduled_deletions_executed_check CHECK (
    (status = 'EXECUTED') = (executed_at IS NOT NULL)
  ),
  CONSTRAINT scheduled_deletions_cancelled_check CHECK (
    (status = 'CANCELLED') = (cancelled_at IS NOT NULL)
  )
);

-- Un seul compte à rebours actif par compte : replanifier ne doit pas créer
-- une seconde échéance qui supprimerait les données plus tôt que prévu.
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_deletions_active_uidx
  ON scheduled_account_deletions (account_id)
  WHERE status = 'SCHEDULED';

-- Index de balayage du travail planifié : les échéances à traiter d'abord.
CREATE INDEX IF NOT EXISTS scheduled_deletions_due_idx
  ON scheduled_account_deletions (scheduled_at)
  WHERE status = 'SCHEDULED';

CREATE INDEX IF NOT EXISTS scheduled_deletions_user_idx
  ON scheduled_account_deletions (user_id);

COMMENT ON TABLE scheduled_account_deletions IS
  'Comptes a rebours de suppression (CDC retractation 13.3). Une seule ligne SCHEDULED par compte.';
COMMENT ON COLUMN scheduled_account_deletions.scheduled_at IS
  'confirmed_at + 30 jours. Fige a l ecriture : jamais recalcule.';
