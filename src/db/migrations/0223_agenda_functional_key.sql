-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0223 : clé fonctionnelle et nature des éléments d'agenda
-- (CDC 15 T4-08, T4-09, D-14, D-15, §12 « AgendaWriteService unifié »).
-- Colonnes ici ; index dans 0223_*_idx_*.sql.
--
--   · functional_key  empreinte (sha-256 tronqué) de
--                     source + cible + type métier + champ d'origine +
--                     occurrence : identifie un élément AUTOMATIQUE d'une
--                     source d'une analyse à l'autre (réanalyse idempotente :
--                     création, mise à jour ou retrait, jamais de doublon) ;
--   · event_nature    HISTORICAL (fait passé : achat, entretien réalisé,
--                     sinistre, vente…) | DEADLINE (échéance future). Un
--                     élément HISTORICAL n'est jamais notifié et n'entre pas
--                     dans les « prochaines échéances » (D-14) ;
--   · business_type   type métier du catalogue d'événements (purchase,
--                     maintenance, claim, sale…).
--
-- NULLABLES, SANS DÉFAUT : les éléments antérieurs restent sans valeur ; une
-- réanalyse (AI_T4_EFFECTS=enabled) adopte les éléments automatiques de sa
-- source et leur pose la clé.
--
-- Élément modifié à la main : AUCUNE colonne nouvelle. `is_automatic_modified`
-- (posé par toute édition du titre, de la date ou de la description, et par la
-- confirmation d'une prévision) ET `manual_status` (réalisé / annulé par
-- l'utilisateur) suffisent : la synchronisation ne met à jour ni ne retire un
-- élément qui porte l'un ou l'autre (§14.6).
--
-- Colonnes NON déclarées dans le schéma Drizzle, volontairement (même choix que
-- 0217) : `agenda_items` est lu partout par `db.select().from(agendaItems)` ;
-- déclarées, une 0223 non appliquée ferait échouer TOUTES les lectures de
-- l'agenda. Lecture et écriture en SQL, conditionnées par
-- `services/agenda/agenda-columns.ts`.
--
-- VERROUS : ADD COLUMN nullable sans défaut = catalogue seul (aucune
-- réécriture), sous ACCESS EXCLUSIVE : `lock_timeout` 5 s. Dépassé : échec
-- signalé (/api/health), retenté au prochain démarrage ; l'agenda fonctionne
-- sans ces colonnes (comportement historique).
-- Idempotente : ADD COLUMN IF NOT EXISTS ; contrainte ajoutée si absente.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE agenda_items
  ADD COLUMN IF NOT EXISTS functional_key TEXT,
  ADD COLUMN IF NOT EXISTS event_nature   TEXT,
  ADD COLUMN IF NOT EXISTS business_type  TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'agenda_items_event_nature_ck'
                    AND conrelid = 'agenda_items'::regclass) THEN
    ALTER TABLE agenda_items
      ADD CONSTRAINT agenda_items_event_nature_ck
      CHECK (event_nature IS NULL OR event_nature IN ('HISTORICAL', 'DEADLINE')) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN agenda_items.functional_key IS
  'Clé fonctionnelle d''un élément automatique (CDC 15 T4-08) : source + cible + type métier + champ + occurrence, hachés.';
COMMENT ON COLUMN agenda_items.event_nature IS
  'HISTORICAL | DEADLINE (CDC 15 D-14) : un élément historique n''est jamais notifié. NULL = inconnu (antérieur).';
COMMENT ON COLUMN agenda_items.business_type IS
  'Type métier du catalogue d''événements (purchase, maintenance, claim, sale…).';
