-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1625 : rappels d'échéance — couverture PAR ÉVÉNEMENT (lot 113AH,
-- carte Trello #732 « Rattraper les rappels J−7 manqués après création ou
-- modification d'un événement »).
--
-- agenda_deadline_reminders — une ligne par occurrence d'événement d'agenda ×
-- échéance effective (date) × destinataire ; le compte est porté par la ligne
-- (suit l'événement lors d'un transfert de bien). Écrite DANS la même
-- transaction que la notification (`notification_outbox`, motif outbox) par
-- `src/lib/notifications/scheduled/deadlines.ts` :
--   · state   pending   — notification en file, pas encore envoyée ;
--             processed — envoi terminé (`outcome` = statut final de la
--                         notification : sent, partial, failed, skipped…) ;
--             cancelled — en file mais devenue périmée (événement déplacé ou
--                         devenu « information », `outcome` = stale ;
--                         échéance passée : expired) — réévaluable si la date
--                         redevient la même (`revived_count`) ;
--   · trigger WRITE (après une écriture validée) | SWEEP (passage périodique) ;
--   · days_before : délai réel (jours calendaires de Paris) à la mise en file ;
--   · outbox_dedupe_key : notification qui porte le rappel (plusieurs
--     événements d'une même date peuvent partager une notification) ;
--   · enqueued_at : mise en file (anti-rafale après changement de date).
--
-- UNIQUE (agenda_item_id, due_date, recipient_user_id) : un événement n'est
-- couvert qu'une fois par date et par destinataire — seconde exécution,
-- redémarrage, double déclenchement, sauvegarde sans changement : rien de plus.
-- Le compte n'entre pas dans la clé : un événement appartient à un seul compte,
-- et un destinataire déjà rappelé ne l'est pas une seconde fois après le
-- transfert du bien vers un autre compte dont il est membre (Duo).
--
-- Aucune reprise de données : les rappels déjà envoyés par l'ancien mécanisme
-- (clé `deadline:j7:<date>`, liste `agendaItemIds`) sont reconnus à la lecture
-- de l'outbox — aucun ancien événement n'est renotifié au déploiement.
-- Aucune donnée personnelle hors identifiants techniques ; supprimée avec le
-- compte, l'événement ou l'utilisateur (ON DELETE CASCADE).
--
-- Additive, idempotente, rejouable. Retour arrière : DROP TABLE
-- agenda_deadline_reminders (le code d'avant 113AH ne la lit pas).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS agenda_deadline_reminders (
  id                 BIGSERIAL   PRIMARY KEY,
  account_id         INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agenda_item_id     INTEGER     NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  due_date           DATE        NOT NULL,
  recipient_user_id  INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state              TEXT        NOT NULL DEFAULT 'pending',
  outcome            TEXT,
  trigger            TEXT        NOT NULL,
  days_before        INTEGER     NOT NULL,
  forecast           BOOLEAN     NOT NULL DEFAULT false,
  outbox_dedupe_key  TEXT        NOT NULL,
  revived_count      INTEGER     NOT NULL DEFAULT 0,
  enqueued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at       TIMESTAMPTZ,
  CONSTRAINT agenda_deadline_reminders_state_check CHECK (state IN ('pending', 'processed', 'cancelled')),
  CONSTRAINT agenda_deadline_reminders_trigger_check CHECK (trigger IN ('WRITE', 'SWEEP')),
  CONSTRAINT agenda_deadline_reminders_days_check CHECK (days_before BETWEEN 0 AND 7)
);

CREATE UNIQUE INDEX IF NOT EXISTS agenda_deadline_reminders_cover_uidx
  ON agenda_deadline_reminders (agenda_item_id, due_date, recipient_user_id);
CREATE INDEX IF NOT EXISTS agenda_deadline_reminders_recipient_idx
  ON agenda_deadline_reminders (account_id, recipient_user_id, state);
CREATE INDEX IF NOT EXISTS agenda_deadline_reminders_outbox_idx
  ON agenda_deadline_reminders (outbox_dedupe_key);
