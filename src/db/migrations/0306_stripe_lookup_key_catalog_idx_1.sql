-- Migration 0306 (index 1/1) : prix contractuel des abonnements (inventaire
-- des références de prix par la reprise historique, revalorisation). UNE
-- instruction par fichier (CONCURRENTLY). Idempotente.
--
-- INDEX OPTIONNEL : sans lui, la reprise parcourt la table — plus lente,
-- jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS account_subscriptions_stripe_price_idx
  ON account_subscriptions (stripe_price_id);
