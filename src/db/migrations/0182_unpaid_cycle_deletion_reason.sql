-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0182 — Cycle d'impayé de 90 jours (Centre d'aide GAP-06,
-- articles AID-BILL-008 et AID-TRANSFER-006).
--
-- Règle cible : J0 échec de paiement → fonctions normales suspendues, compte
-- accessible (consultation, export, transmission) ; J0 → J+90 régularisation
-- possible ; J+90 sans régularisation → accès retiré et suppression des
-- données métier/utilisateur par le workflow unique de suppression.
--
-- Le cycle est porté par `accounts.past_due_grace_started_at` (J0) et
-- `accounts.past_due_grace_ends_at` (J+90) ; la suppression passe par
-- `scheduled_account_deletions`, avec un nouveau motif 'UNPAID' (origine
-- 'system').
--
-- Idempotente : peut être rejouée sans effet.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE scheduled_account_deletions DROP CONSTRAINT IF EXISTS scheduled_deletions_reason_check;
ALTER TABLE scheduled_account_deletions ADD CONSTRAINT scheduled_deletions_reason_check CHECK (reason IN (
  'WITHDRAWAL',        -- rétractation confirmée
  'VOLUNTARY',         -- demande explicite du titulaire
  'TRIAL_ABANDONED',   -- essai expiré sans souscription
  'ADMIN',             -- suppression déclenchée depuis le back-office (ACC-A14)
  'UNPAID'             -- J+90 d'un impayé non régularisé (GAP-06)
));

-- Balayage quotidien du cycle : seuls les comptes en cycle ouvert.
CREATE INDEX IF NOT EXISTS accounts_past_due_grace_started_at_idx
  ON accounts (past_due_grace_started_at)
  WHERE past_due_grace_started_at IS NOT NULL;

COMMENT ON COLUMN accounts.past_due_grace_started_at IS
  'J0 du cycle d''impayé (premier échec de paiement non régularisé). NULL hors cycle.';
COMMENT ON COLUMN accounts.past_due_grace_ends_at IS
  'J+90 du cycle d''impayé : échéance de suppression sans régularisation (GAP-06).';

-- ── Cycles ouverts AVANT cette règle ───────────────────────────────────────
-- Les colonnes portaient une « grâce » de 15 jours, et aucun titulaire n'a
-- été prévenu d'une suppression à J+90. Lecture prudente : un cycle antérieur
-- ne peut pas aboutir à une suppression sans préavis. Son échéance est portée
-- à J+90, et au minimum à 30 jours après le déploiement, ce qui laisse passer
-- les rappels J-7 et J-1 du balayage quotidien.
-- Rejouable : GREATEST ne raccourcit jamais une échéance.
UPDATE accounts
   SET past_due_grace_ends_at = GREATEST(
         past_due_grace_started_at + interval '90 days',
         COALESCE(past_due_grace_ends_at, past_due_grace_started_at + interval '90 days'),
         now() + interval '30 days')
 WHERE past_due_grace_started_at IS NOT NULL
   AND (past_due_grace_ends_at IS NULL OR past_due_grace_ends_at < past_due_grace_started_at + interval '90 days');
