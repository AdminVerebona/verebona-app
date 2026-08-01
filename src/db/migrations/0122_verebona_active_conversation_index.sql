-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0122 — Index PARTIEL sur la conversation active
--
-- ── CE QUE CET INDEX EMPÊCHE ──────────────────────────────────────────────
--
-- Le §28.1 impose UNE conversation ACTIVE par compte. La migration 0100 posait
-- le bon index, avec son prédicat.
--
-- Mais `src/db/verebona-schema.ts` déclarait `.where(undefined as never)`, qui
-- ne produit AUCUN prédicat. Sur toute base créée par `drizzle-kit push` —
-- c'est le mode opératoire du projet —, l'index posé est donc unique sur
-- `account_id` seul.
--
-- `push` s'exécutant avant les migrations, le `IF NOT EXISTS` de la 0100
-- trouvait l'index déjà présent et n'y touchait pas.
--
-- ── LA CONSÉQUENCE OBSERVÉE ───────────────────────────────────────────────
--
-- Un compte ne peut avoir qu'UNE conversation, jamais une conversation
-- ACTIVE. Après un effacement d'historique (§24.5) qui la marque `deleted`,
-- aucune nouvelle conversation ne peut être créée : l'assistant continue
-- d'écrire dans un historique que l'utilisateur a demandé d'effacer.
--
-- ── POURQUOI UN DROP EXPLICITE ────────────────────────────────────────────
--
-- `CREATE INDEX IF NOT EXISTS` ne corrige jamais un index existant : il
-- constate sa présence et s'arrête. Il faut le retirer pour le reposer.
-- ═══════════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS verebona_conversations_active_account_uidx;

CREATE UNIQUE INDEX verebona_conversations_active_account_uidx
  ON verebona_conversations (account_id)
  WHERE status = 'active';
