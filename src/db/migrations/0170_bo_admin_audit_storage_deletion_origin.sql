-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0170 — Back-office V1 : journal d'audit, origine des suppressions,
-- plafonds de stockage.
--
-- CDC Back-Office V1 :
--   1. AUD-001 / AUD-003 — le journal technique porte le RÉSULTAT de l'action
--      et, lorsque pertinent, l'ANCIENNE et la NOUVELLE valeur. Jusqu'ici seul
--      un texte libre `details` existait : une action refusée ou en échec ne
--      se distinguait pas d'une action réussie.
--   2. ACC-A14 — la suppression déclenchée depuis le BO passe par le workflow
--      unique `scheduled_account_deletions` ; « seule l'origine diffère ».
--      L'origine devient une colonne explicite (user / system / admin) et le
--      motif ADMIN est admis.
--   3. STO-001 — plafond de stockage par offre, configurable en base
--      (2 Go Standard, 10 Go Premium, 15 Go Premium Duo ; 1 Go = 1024³ octets).
--
-- Idempotente : peut être rejouée sans effet.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Journal d'audit administrateur ──────────────────────────────────────────
ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS result    TEXT;
ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS old_value JSONB;
ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS new_value JSONB;

-- Les lignes antérieures n'ont pas de résultat connu : NULL, et non SUCCESS,
-- pour ne rien affirmer qu'on ignore.
ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_result_check;
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_result_check
  CHECK (result IS NULL OR result IN ('SUCCESS', 'FAILURE', 'DENIED'));

-- Diagnostic « qu'est-il arrivé à ce compte / cet utilisateur ? ».
CREATE INDEX IF NOT EXISTS admin_audit_log_target_idx
  ON admin_audit_log (target_type, target_id);

-- 2. Origine des suppressions de compte ────────────────────────────────────
ALTER TABLE scheduled_account_deletions ADD COLUMN IF NOT EXISTS origin TEXT;

-- Rétro-remplissage : rétractation et demande volontaire émanent de
-- l'utilisateur ; l'essai abandonné est une purge système.
UPDATE scheduled_account_deletions
   SET origin = CASE WHEN reason = 'TRIAL_ABANDONED' THEN 'system' ELSE 'user' END
 WHERE origin IS NULL;

ALTER TABLE scheduled_account_deletions ALTER COLUMN origin SET DEFAULT 'user';
ALTER TABLE scheduled_account_deletions ALTER COLUMN origin SET NOT NULL;

ALTER TABLE scheduled_account_deletions DROP CONSTRAINT IF EXISTS scheduled_deletions_origin_check;
ALTER TABLE scheduled_account_deletions ADD CONSTRAINT scheduled_deletions_origin_check
  CHECK (origin IN ('user', 'system', 'admin'));

ALTER TABLE scheduled_account_deletions DROP CONSTRAINT IF EXISTS scheduled_deletions_reason_check;
ALTER TABLE scheduled_account_deletions ADD CONSTRAINT scheduled_deletions_reason_check CHECK (reason IN (
  'WITHDRAWAL',        -- rétractation confirmée
  'VOLUNTARY',         -- demande explicite du titulaire
  'TRIAL_ABANDONED',   -- essai expiré sans souscription
  'ADMIN'              -- suppression déclenchée depuis le back-office (ACC-A14)
));

-- 3. Plafonds de stockage par offre ────────────────────────────────────────
ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS max_storage_bytes BIGINT;

UPDATE plan_limits SET max_storage_bytes = 2::bigint  * 1024 * 1024 * 1024 WHERE plan_code = 'standard';
UPDATE plan_limits SET max_storage_bytes = 10::bigint * 1024 * 1024 * 1024 WHERE plan_code = 'premium';
UPDATE plan_limits SET max_storage_bytes = 15::bigint * 1024 * 1024 * 1024 WHERE plan_code = 'premium_duo';
-- premium_pro : hors CDC BO (offre non commercialisée) — NULL = repli sur la
-- valeur du code (`src/lib/storage-quota.ts`).
