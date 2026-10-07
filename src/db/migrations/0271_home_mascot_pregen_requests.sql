-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0271 : demandes DURABLES de pré-génération de la mascotte — lot 32
-- (décision PO 6 : « pas de modification de texte sous les yeux, mais le texte
-- IA doit apparaître plus vite »).
--
-- Jusqu'ici la pré-génération (RUN-007) était une minuterie EN MÉMOIRE de
-- l'instance qui recevait l'événement : perdue au redémarrage, absente quand
-- le changement venait d'une tâche planifiée ou d'une autre instance, et
-- jamais déclenchée par le simple passage d'une échéance. Le texte T6 n'était
-- donc souvent prêt qu'à l'affichage SUIVANT celui qui le demandait.
--
-- Une ligne par compte (dédupliquée) : la situation du compte a changé depuis
-- `requested_at` ; la tâche planifiée `mascot-pregeneration` la traite (lot
-- borné, coût plafonné par compte et par jour) et note l'empreinte de la
-- situation formulée (`last_context_hash`) — une même situation n'est jamais
-- reformulée (le cache T6 du compte la sert).
--
-- Idempotente (IF NOT EXISTS). Retour arrière : table ignorée par l'ancien code.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS home_mascot_pregen_requests (
  account_id         INTEGER     PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  -- Dernier changement de situation signalé (fusionne les rafales).
  requested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Origine du dernier signal (événement métier, échéance, connexion…), sans donnée personnelle.
  reason             TEXT,
  -- Dernier traitement (NULL : jamais) ; une demande est EN ATTENTE si requested_at > processed_at.
  processed_at       TIMESTAMPTZ,
  -- Empreinte de la situation formulée au dernier traitement.
  last_context_hash  TEXT,
  last_status        TEXT,
  attempts           INTEGER     NOT NULL DEFAULT 0,
  -- Prise en charge par une exécution (bail) : une autre instance ne la reprend pas avant expiration.
  claimed_until      TIMESTAMPTZ
);

COMMENT ON TABLE home_mascot_pregen_requests IS
  'Pré-génération durable du texte T6 de la mascotte d''accueil (lot 32, décision PO 6) : une ligne par compte, traitée par la tâche planifiée mascot-pregeneration.';
