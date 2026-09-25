-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0150 — Statut de compte WITHDRAWN (récupération après rétractation)
--
-- Le traitement d'une rétractation passe le compte en `WITHDRAWN` (lecture et
-- export seuls, CDC rétractation §13). Or la contrainte
-- `accounts_subscription_status_check` ne connaissait pas cette valeur :
-- l'écriture échouait, le traitement s'interrompait, et le compte gardait ses
-- droits d'écriture. Valeur ajoutée (la liste de la 0055 est alignée).
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_subscription_status_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_subscription_status_check
  CHECK (subscription_status IN (
    'NONE','ACTIVE','CANCELED','EXPIRED',
    'PAST_DUE','PAST_DUE_GRACE','UNPAID_RECOVERY','TRIALING','WITHDRAWN'
  ));
