-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0323 : le Sinistre devient l'Opération CLAIM (lot 44, O5 — CDC
-- Opérations V1 ch. 15, B14, C13.1, C14, C14.1 à C14.3, C23, C23.1 ;
-- décisions PO Q2, Q3, Q4, Q11 du 11/10).
--
-- 1. `business_operation_claim_details.history_event_id` : événement de
--    l'HISTORIQUE (table `events`) choisi comme ancre du sinistre. Un élément
--    d'AGENDA, lui, est lié par `agenda_items.business_operation_id` (0318,
--    C14 « claimEventKey → Agenda event.business_operation_id ») : l'ancienne
--    clé `claimEventKey` n'est plus le pivot. SET NULL si l'événement
--    disparaît (aucune perte du sinistre).
--
-- 2. `item_key` des listes du Sinistre (dommages, actions, échanges) :
--    identifiant STABLE de la ligne côté formulaire (« r3f2… », celui du JSON
--    historique) — le formulaire remplace une liste en bloc (même sémantique
--    que le lot 34) et retrouve ses lignes d'un enregistrement à l'autre.
--    Facultatif : une ligne sans clé est rendue « d<id> ».
--
-- 3. `business_operation_claim_migration_marks` : un repère par bien de la
--    migration C14.3 de l'ancien formulaire (`asset_additional_infos.
--    claim_json`) — version de migration, empreinte (md5 du JSON) de l'état
--    examiné, Opération CLAIM obtenue, issue. Rejouer un bien dont le JSON n'a
--    pas changé n'écrit rien. Le miroir de compatibilité (Q11 : `claim_json`
--    reflète le sinistre le plus récent du bien tant que la fenêtre de retour
--    arrière est ouverte) met l'empreinte à jour dans la même transaction :
--    seule une écriture EXTERNE de l'ancien JSON (ancien client) est reprise.
--    Technique, invisible pour l'utilisateur (P09).
--
-- Idempotente (IF NOT EXISTS, garde sur la contrainte) ; expand seulement.
-- Colonnes nullables sans défaut : ajout instantané. Contrainte posée NOT
-- VALID puis validée (table de détail de petite taille).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE business_operation_claim_details ADD COLUMN IF NOT EXISTS history_event_id INTEGER;

-- Nom de la convention Drizzle : une base créée par `push` (outillage,
-- e2e) a déjà cette contrainte, jamais en double.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'business_operation_claim_details_history_event_id_events_id_fk' AND conrelid = 'business_operation_claim_details'::regclass
  ) THEN
    ALTER TABLE business_operation_claim_details
      ADD CONSTRAINT business_operation_claim_details_history_event_id_events_id_fk
      FOREIGN KEY (history_event_id) REFERENCES events(id) ON DELETE SET NULL NOT VALID;
    ALTER TABLE business_operation_claim_details VALIDATE CONSTRAINT business_operation_claim_details_history_event_id_events_id_fk;
  END IF;
END $$;

ALTER TABLE business_operation_claim_damages ADD COLUMN IF NOT EXISTS item_key TEXT;
ALTER TABLE business_operation_claim_actions ADD COLUMN IF NOT EXISTS item_key TEXT;
ALTER TABLE business_operation_claim_exchanges ADD COLUMN IF NOT EXISTS item_key TEXT;

CREATE TABLE IF NOT EXISTS business_operation_claim_migration_marks (
  asset_id          INTEGER      PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  account_id        INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  migration_version TEXT         NOT NULL,
  data_fingerprint  TEXT         NOT NULL,
  operation_id      BIGINT       REFERENCES business_operations(id) ON DELETE SET NULL,
  outcome           TEXT         NOT NULL,
  detail            JSONB        NOT NULL DEFAULT '{}'::jsonb,
  processed_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT business_operation_claim_migration_marks_detail_chk CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT business_operation_claim_migration_marks_outcome_chk CHECK (outcome IN ('CREATED', 'MATCHED', 'LINKED', 'RESYNCED', 'MIRRORED', 'BELOW_THRESHOLD', 'HOLD_AMBIGUOUS', 'EMPTY', 'ERROR'))
);
