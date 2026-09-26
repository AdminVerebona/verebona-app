-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0181 — Usages des codes promotionnels Stripe.
--
-- CDC Back-Office V1 §8.3 (PRO-002) : usages, conversions payantes et comptes
-- concernés. L'écran BO lit les usages dans `signup_contexts`
-- (resolved_code_type = 'promo_code'), mais aucun code ne les y écrivait, et
-- `promo_codes.redemption_count` restait à 0.
--
-- Un usage est enregistré par le webhook Stripe à la souscription
-- (`checkout.session.completed`, `customer.subscription.created`), sous la
-- forme d'une ligne `signup_contexts` SANS user_id (l'index unique
-- `signup_contexts_user_uidx` réserve la ligne user_id au contexte
-- d'inscription / parrainage) et avec validation_status = 'redeemed' (jamais
-- 'valid' : `getStoredReferralCode` la prendrait pour un code de parrainage).
--
-- Idempotence : un usage par (compte, code promotionnel Stripe). Le rejeu
-- d'un événement, ou la réception des deux événements d'une même
-- souscription, n'incrémente pas deux fois le compteur.
--
-- Idempotente : peut être rejouée sans effet.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS signup_contexts_promo_redemption_uidx
  ON signup_contexts (account_id, stripe_promotion_code_id)
  WHERE code_source = 'stripe_promotion_code'
    AND account_id IS NOT NULL
    AND stripe_promotion_code_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS promo_codes_stripe_promotion_code_id_idx
  ON promo_codes (stripe_promotion_code_id);
