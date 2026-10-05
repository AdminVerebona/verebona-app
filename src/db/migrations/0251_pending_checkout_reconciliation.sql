-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0251 : suivi explicite du paiement en attente (APP-PERF-18).
--
-- `accounts.checkout_session_id` / `checkout_session_created_at` marquent un
-- paiement Stripe Checkout ouvert et pas encore appliqué. Leur vérification
-- se faisait PENDANT la lecture des droits (`/api/billing/trial-status`,
-- appel Stripe attendu, filet de 20 s par instance). Elle passe à une
-- réconciliation durable (tâche planifiée + déclenchement non bloquant),
-- qui a besoin d'un état partagé entre instances :
--
--   checkout_check_attempts  vérifications Stripe déjà faites pour ce paiement
--   checkout_next_check_at   prochaine vérification autorisée (recul
--                            progressif ; sert aussi de réservation : une
--                            seule instance vérifie un compte à la fois)
--
-- Remis à zéro à chaque nouvelle session Checkout, effacés avec le marqueur
-- quand le paiement est appliqué ou la session expirée.
--
-- Rétrocompatible : colonnes nullables / avec défaut, aucune réécriture ;
-- l'ancien code les ignore. Retour arrière : DROP COLUMN des deux colonnes
-- et de l'index (aucune autre donnée n'en dépend).
-- Idempotente : IF NOT EXISTS.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS checkout_check_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS checkout_next_check_at  TIMESTAMPTZ;

COMMENT ON COLUMN accounts.checkout_check_attempts IS
  'Vérifications Stripe du paiement en attente (checkout_session_id) déjà effectuées. APP-PERF-18.';
COMMENT ON COLUMN accounts.checkout_next_check_at IS
  'Prochaine vérification autorisée du paiement en attente (recul, réservation entre instances). APP-PERF-18.';

CREATE INDEX IF NOT EXISTS accounts_pending_checkout_idx
  ON accounts (checkout_next_check_at)
  WHERE checkout_session_id IS NOT NULL;
