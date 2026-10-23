-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0640 : récapitulatif « À traiter » — préparé ≠ envoyé, reprise et
-- couverture complète (lot 81E).
--
--   1. to_process_digest_state (0621) : `item_keys` / `total` /
--      `last_emitted_at` désignent désormais le DERNIER CONTENU COMMUNIQUÉ
--      (au moins un canal accepté). Colonnes ajoutées :
--        sent_fingerprints     empreinte par action (identifiant × cycle ×
--                              priorité × contenu) du dernier contenu
--                              communiqué — détecte une évolution
--                              significative d'une action existante ;
--        prepared_*            récapitulatif PRÉPARÉ (mis en file), promu
--                              « communiqué » seulement après l'envoi ;
--        channel_results       résultat par canal du dernier envoi (reprise
--                              ciblée) ; last_outcome : sent | partial |
--                              failed | skipped ;
--        attempt_seq           identité de chaque préparation (clé de
--                              déduplication) ; attempts_on_date / last_attempt_date
--                              bornent les reprises d'un échec dans la journée.
--   2. Contenu enregistré par l'ancien code AU MOMENT DE LA MISE EN FILE :
--      remis à vide quand le dernier récapitulatif de ce destinataire n'a été
--      accepté par AUCUN canal (état reconstructible par les livraisons) —
--      le contenu non communiqué sera renvoyé.
--   3. to_process_digest_runs — un passage par date locale, curseur de compte
--      (`cursor_account_id`) : parcours complet par pagination stable, repris
--      au passage suivant (toutes les 15 min de 8 h 30 à 11 h) ; plus de
--      plafond global de 1 000 comptes.
--
-- Pas de bien ni de fichier : hors classement des transferts de biens.
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS to_process_digest_state (
  account_id       INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id          INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_keys        TEXT[]      NOT NULL DEFAULT '{}',
  total            INTEGER     NOT NULL DEFAULT 0,
  last_emitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);

ALTER TABLE to_process_digest_state ADD COLUMN IF NOT EXISTS sent_fingerprints text[];
ALTER TABLE to_process_digest_state ADD COLUMN IF NOT EXISTS prepared_item_keys text[];
ALTER TABLE to_process_digest_state ADD COLUMN IF NOT EXISTS prepared_fingerprints text[];
ALTER TABLE to_process_digest_state ADD COLUMN IF NOT EXISTS prepared_total integer;
ALTER TABLE to_process_digest_state ADD COLUMN IF NOT EXISTS prepared_outbox_id uuid;
ALTER TABLE to_process_digest_state ADD COLUMN IF NOT EXISTS prepared_at timestamptz;
ALTER TABLE to_process_digest_state ADD COLUMN IF NOT EXISTS channel_results jsonb;
ALTER TABLE to_process_digest_state ADD COLUMN IF NOT EXISTS last_outcome text;
ALTER TABLE to_process_digest_state ADD COLUMN IF NOT EXISTS attempt_seq integer NOT NULL DEFAULT 0;
ALTER TABLE to_process_digest_state ADD COLUMN IF NOT EXISTS attempts_on_date integer NOT NULL DEFAULT 0;
ALTER TABLE to_process_digest_state ADD COLUMN IF NOT EXISTS last_attempt_date date;

-- (2) Contenu jamais communiqué (dernier récapitulatif sans aucun canal accepté).
UPDATE to_process_digest_state s
   SET item_keys = '{}', total = 0, last_outcome = 'failed'
 WHERE s.sent_fingerprints IS NULL
   AND cardinality(s.item_keys) > 0
   AND EXISTS (
     SELECT 1 FROM (
       SELECT o.id FROM notification_outbox o
        WHERE o.event_type = 'TO_PROCESS_DAILY_DIGEST'
          AND o.recipient_user_id = s.user_id AND o.account_id = s.account_id
        ORDER BY o.created_at DESC LIMIT 1
     ) dernier
     WHERE NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.outbox_id = dernier.id AND d.status = 'sent')
       AND EXISTS (SELECT 1 FROM notification_outbox o2 WHERE o2.id = dernier.id
                    AND o2.status NOT IN ('pending', 'processing')));

CREATE TABLE IF NOT EXISTS to_process_digest_runs (
  local_date         date        PRIMARY KEY,
  cursor_account_id  integer     NOT NULL DEFAULT 0,
  accounts_scanned   integer     NOT NULL DEFAULT 0,
  emitted            integer     NOT NULL DEFAULT 0,
  started_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);
