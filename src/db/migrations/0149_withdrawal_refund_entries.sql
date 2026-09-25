-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0149 — Suivi individuel des remboursements d'une rétractation
--
-- La clôture reposait sur le nombre et le statut des remboursements
-- (`stripe_refund_ids` / `stripe_refund_statuses`, deux listes parallèles
-- sans montant). À chaque webhook, seul le montant du remboursement courant
-- était connu : le total remboursé n'était pas reconstruit, et une demande
-- pouvait être close sans que le montant attendu soit atteint.
--
-- Chaque remboursement est désormais suivi individuellement :
--   [{ refundId, paymentId, amount, status, eventCreated, updatedAt }]
-- Le total remboursé est recalculé depuis les remboursements réussis.
-- Les anciennes listes sont conservées (compatibilité) et reprises ici.
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS stripe_refunds_json JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Reprise des demandes existantes : identifiants et statuts, montant inconnu
-- (reconstruit auprès de Stripe au prochain événement).
UPDATE withdrawal_requests w
   SET stripe_refunds_json = (
     SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'refundId', ids.id, 'paymentId', NULL, 'amount', NULL,
              'status', COALESCE(st.status, 'pending'), 'eventCreated', NULL, 'updatedAt', NULL)
            ORDER BY ids.ord), '[]'::jsonb)
       FROM jsonb_array_elements_text(COALESCE(NULLIF(w.stripe_refund_ids, ''), '[]')::jsonb) WITH ORDINALITY AS ids(id, ord)
       LEFT JOIN jsonb_array_elements_text(COALESCE(NULLIF(w.stripe_refund_statuses, ''), '[]')::jsonb) WITH ORDINALITY AS st(status, ord)
         ON st.ord = ids.ord
   )
 WHERE w.stripe_refunds_json = '[]'::jsonb
   AND COALESCE(NULLIF(w.stripe_refund_ids, ''), '[]') <> '[]';
