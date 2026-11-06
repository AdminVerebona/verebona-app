-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1321 : récupération automatique des montants (lot 108B, 1045) —
-- statut NOT_APPLICABLE (lot 111V, ticket « TCO — anomalies corrigeables » §D).
--
-- Une récupération ouverte sur un document qui n'attend plus aucun montant
-- (contrat, attestation, procès-verbal sans montant ; « aucune dépense sur ce
-- document » confirmé par l'utilisateur) est close « sans objet » : jamais
-- « montant retrouvé », jamais relancée (aucune relecture en boucle).
--
-- Élargissement de la contrainte seulement (toute ligne existante reste
-- valide). Idempotente et rejouable. Retour arrière : remettre la contrainte
-- de 1045 après UPDATE … SET status = 'NOT_FOUND' WHERE status = 'NOT_APPLICABLE'.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE document_amount_recoveries DROP CONSTRAINT IF EXISTS document_amount_recoveries_status_chk;
ALTER TABLE document_amount_recoveries ADD CONSTRAINT document_amount_recoveries_status_chk
  CHECK (status IN ('PENDING', 'T1_PENDING', 'RECOVERED', 'TO_CONFIRM', 'NOT_FOUND', 'TECHNICAL_FAILURE', 'USER_OWNED', 'NOT_APPLICABLE'));
