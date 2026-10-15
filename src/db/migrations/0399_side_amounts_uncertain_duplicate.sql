-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0399 : montant hors total « UNCERTAIN_DUPLICATE » (lot 55B, ticket
-- P1 « factures d'un même contrat », développement D).
--
-- Une facture sans référence, sans date et sans période, de même rôle et de
-- même montant qu'un fait déjà compté dans l'Opération : copie ou autre
-- échéance, on ne sait pas. Le montant est compté UNE fois ; l'excédent est
-- conservé, tracé à ses sources, HORS du total (jamais additionné d'office,
-- jamais perdu) — même mécanisme que les frais annexes (0351).
--
-- Contrainte remplacée (même liste + la nouvelle nature). Idempotente.
-- Retour arrière : DELETE des lignes UNCERTAIN_DUPLICATE puis contrainte 0351.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE business_operation_side_amounts DROP CONSTRAINT IF EXISTS business_operation_side_amounts_nature_chk;
ALTER TABLE business_operation_side_amounts
  ADD CONSTRAINT business_operation_side_amounts_nature_chk
  CHECK (nature IN ('ANCILLARY_FEE', 'DOCUMENT_AMOUNT_DIFFERS', 'UNCERTAIN_DUPLICATE')) NOT VALID;
ALTER TABLE business_operation_side_amounts VALIDATE CONSTRAINT business_operation_side_amounts_nature_chk;
