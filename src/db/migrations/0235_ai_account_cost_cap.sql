-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0235 : plafond mensuel de coût IA par compte (lot 22, chantier A —
-- revue L16b-3).
--
--   · ai_account_cost_caps : DÉROGATION par compte au plafond de son offre,
--     posée depuis Suivi IA > compte (`PATCH /api/admin/ai/accounts/[id]/quota`,
--     journalisée dans ai_admin_audit_log). Absente : le plafond de l'offre
--     s'applique (réglages administrés `ai_cost_cap_<offre>_micros`,
--     verebona_assistant_settings, lot 21). 0 = sans plafond pour ce compte.
--     Montants en micro-USD, comme ai_usage_event.cost_micros.
--   · L'index de lecture du cumul mensuel d'un compte est construit à part
--     (0235_ai_account_cost_cap_idx_1.sql, CONCURRENTLY).
--
-- Aucune valeur posée = aucun plafond : comportement inchangé.
-- Idempotente. Aucune déclaration Drizzle : lue et écrite en SQL direct
-- (`services/ai/gateway/account-cost-cap.ts`).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_account_cost_caps (
  account_id          INTEGER     PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  monthly_cap_micros  BIGINT      NOT NULL,
  reason              TEXT,
  updated_by          INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_account_cost_caps_amount_check CHECK (monthly_cap_micros >= 0)
);

COMMENT ON TABLE ai_account_cost_caps IS
  'Dérogation par compte au plafond mensuel de coût IA de son offre (lot 22). Absente : plafond de l''offre ; '
  '0 : sans plafond. Mois civil Europe/Paris, coûts réels ai_usage_event hors T5. Historique : ai_admin_audit_log.';
