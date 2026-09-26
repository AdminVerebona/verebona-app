-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0173 — Back-office V1 : activation des communications par canal.
--
-- CDC Back-Office V1 §10 :
--   COM-002 / COM-011 — l'activation se fait PAR CANAL (e-mail, push, in-app),
--     jamais globalement au niveau de l'événement ;
--   COM-012 — la désactivation est confirmée et journalisée (admin_audit_log,
--     via logAdminAction : pas de journal ici) ;
--   REC-MOD-01 — désactiver un canal n'affecte pas les autres canaux.
--
-- Une ligne n'existe que pour un canal dont l'état a été modifié depuis le BO :
-- l'ABSENCE de ligne vaut « actif ». Aucun rétro-remplissage n'est donc
-- nécessaire et un événement ajouté au catalogue est actif d'office.
--
-- event_code :
--   · type d'événement du catalogue des notifications (ex. TRIAL_ENDING) ;
--   · « email:<CODE> » pour un e-mail transactionnel envoyé hors catalogue
--     (ex. email:WELCOME). Le préfixe évite la collision entre un type
--     d'événement et un gabarit homonyme (ACCOUNT_INVITATION existe dans les
--     deux espaces).
--
-- Idempotente : peut être rejouée sans effet.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS communication_channel_settings (
  event_code  TEXT        NOT NULL,
  channel     TEXT        NOT NULL,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_code, channel)
);

ALTER TABLE communication_channel_settings
  DROP CONSTRAINT IF EXISTS communication_channel_settings_channel_check;
ALTER TABLE communication_channel_settings
  ADD CONSTRAINT communication_channel_settings_channel_check
  CHECK (channel IN ('email', 'push', 'in_app'));

-- COM-003 : dernier envoi réel et nombre d'envois des e-mails transactionnels.
CREATE INDEX IF NOT EXISTS email_logs_template_status_idx
  ON email_logs (upper(template_code), status);
