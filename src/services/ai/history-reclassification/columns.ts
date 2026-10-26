/**
 * Présence de la colonne `ai_usage_event.history_execution_id` (migration
 * 0776, lot 89A) pour les lectures « appels d'une exécution » : colonne
 * absente → aucun rattachement par reclassement (jamais d'erreur d'écran).
 * Mise en cache : présente une fois, présente pour la vie du processus ;
 * absente, revérifiée au plus toutes les 60 s.
 */
type Row = Record<string, unknown>;
type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;

let present = false;
let checkedAt = 0;

export async function historyExecutionColumnReady(q: Query): Promise<boolean> {
  if (present) return true;
  if (Date.now() - checkedAt < 60_000) return false;
  checkedAt = Date.now();
  try {
    const r = await q(`SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'ai_usage_event' AND column_name = 'history_execution_id'`);
    present = r.length > 0;
  } catch {
    present = false;
  }
  return present;
}

