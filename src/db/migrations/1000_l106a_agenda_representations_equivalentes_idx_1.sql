-- verebona:optional-index
-- Migration 1000 (index 1/1) : décisions d'équivalence Agenda par compte et groupe (diagnostic, mémoire du
-- contrôle COH-AGENDA-EQUIVALENT-REPRESENTATIONS) — lot 106A. UNE instruction par fichier
-- (`CREATE INDEX CONCURRENTLY` hors transaction). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS agenda_equivalence_decisions_account_group_idx
  ON agenda_equivalence_decisions (account_id, group_key, created_at);
