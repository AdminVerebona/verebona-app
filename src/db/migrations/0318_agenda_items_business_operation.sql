-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0318 : lien Agenda → Opération (lot 39, O1 — CDC Opérations V1
-- C16.1, C16.2, C20, B24).
--
--   · business_operation_id      : Opération représentée par l'événement
--     (projection T4, ou événement utilisateur lié au lieu d'être dupliqué) ;
--     SET NULL si l'Opération disparaît (suppression du compte seulement) ;
--   · projection_origin          : 'OPERATION' quand l'événement a été GÉNÉRÉ
--     depuis une Opération (C16.1) — marqueur anti-boucle C16.2 ;
--   · projection_correlation_id  : correlation_id de la chaîne T3 → T4.
--
-- Aucune écriture dans ce lot (T4 au lot O7). La contrainte historique
-- `origin_type` n'est PAS modifiée : le marqueur de projection est porté par
-- `projection_origin`, ce qui évite de toucher aux deux contraintes CHECK
-- existantes (`agenda_items_origin_type_check`, `chk_agenda_items_origin_type`)
-- et à leurs lecteurs (agenda, mascotte, exports, KPI).
--
-- Colonnes nullables sans défaut : ajout instantané (métadonnées). Contraintes
-- posées NOT VALID (aucun parcours de table sous verrou), validées par 0319.
-- Index : `0318_agenda_items_business_operation_idx_1` (CONCURRENTLY).
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS business_operation_id BIGINT;
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS projection_origin TEXT;
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS projection_correlation_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agenda_items_business_operation_fk' AND conrelid = 'agenda_items'::regclass
  ) THEN
    ALTER TABLE agenda_items
      ADD CONSTRAINT agenda_items_business_operation_fk
      FOREIGN KEY (business_operation_id) REFERENCES business_operations(id) ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agenda_items_projection_origin_check' AND conrelid = 'agenda_items'::regclass
  ) THEN
    ALTER TABLE agenda_items
      ADD CONSTRAINT agenda_items_projection_origin_check
      CHECK (projection_origin IS NULL OR projection_origin = 'OPERATION') NOT VALID;
  END IF;
END $$;
