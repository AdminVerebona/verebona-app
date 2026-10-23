/**
 * Lot 82E — signature du schéma des tables sauvegardées (sauvegarde v2,
 * restauration) et périmètre de la restauration. PUR, sauf `readSchemaSignature`.
 *
 * Une restauration réinjecte les lignes d'un point antérieur dans les tables
 * ACTUELLES : elle n'est sûre que si chaque table a exactement les mêmes
 * colonnes (nom, type) qu'au moment du point. La signature de chaque table
 * est donc enregistrée dans le manifeste de la sauvegarde et comparée avant
 * toute écriture ; une différence (migration passée depuis, table ajoutée ou
 * retirée) rend le point NON restaurable, avec la liste des écarts.
 */
import { createHash } from 'node:crypto';

type Row = Record<string, unknown>;
export type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;

/** Tables jamais sauvegardées : purement techniques (suivi des migrations, baux de tâches). */
export const BACKUP_EXCLUDED_TABLES: readonly string[] = ['_migrations', 'job_locks'];

/**
 * Tables sauvegardées mais CONSERVÉES dans leur état courant à la
 * restauration (décision PO D13 du Pilotage IA : « les rapports de tests et
 * diagnostics restent consultables après une restauration ») : la base
 * métier revient au point, mais ce qui s'est PASSÉ depuis reste analysable.
 *   · journaux d'administration, suivi des exports, des rattrapages et des
 *     tâches planifiées, battements des workers ;
 *   · révocations de sécurité (un jeton révoqué après le point ne doit
 *     jamais redevenir valide) ;
 *   · supervision (anomalies) et traces IA : appels, diagnostics d'appel,
 *     opérations et étapes, rapports d'exécution, journaux d'accès sensibles,
 *     coûts et compteurs d'usage réellement consommés ;
 *   · rapports de tests et de qualification IA ;
 *   · journaux d'envois et de webhooks externes (ce qui a réellement été
 *     envoyé ou reçu), journal juridique.
 */
export const RESTORE_KEEP_CURRENT_TABLES: readonly string[] = [
  ...BACKUP_EXCLUDED_TABLES,
  'admin_audit_log', 'admin_export_generations', 'ops_backfill_runs', 'scheduled_task_state', 'ai_queue_worker_heartbeats',
  'revoked_tokens', 'user_session_revocations', 'auth_rate_limits',
  'admin_anomalies', 'admin_anomaly_occurrences',
  'ai_usage_event', 'ai_usage_events', 'ai_usage_daily_rollup', 'ai_usage_account_counter', 'ai_call_diagnostics', 'ai_operation',
  'ai_pipeline_step', 'ai_log_archives', 'ai_admin_audit_log', 'ai_t2_content_access_log', 'ai_execution_reports', 'ai_execution_report_entries',
  'ai_call_captures', 'ai_call_capture_state',
  'ai_evaluator_runs', 'ai_master_corpus_runs', 'ai_master_prompt_test_runs', 'ai_prompt_test_runs', 'ai_model_qualification',
  'email_logs', 'email_provider_events', 'stripe_webhook_logs', 'legal_audit_log',
];

/** Colonnes d'une table, triées : `nom:type` (`:g` si générée — jamais réinjectée). */
export type SchemaSignature = Record<string, string[]>;

export async function readSchemaSignature(q: Query): Promise<SchemaSignature> {
  const rows = await q(`
    SELECT c.table_name, c.column_name, c.udt_name, c.is_generated
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name, c.column_name`);
  const out: SchemaSignature = {};
  for (const r of rows) {
    const t = String(r.table_name);
    (out[t] ??= []).push(`${String(r.column_name)}:${String(r.udt_name)}${r.is_generated === 'ALWAYS' ? ':g' : ''}`);
  }
  return out;
}

/** Empreinte stable (SHA-256, 16 premiers caractères) d'une signature complète — affichage et comparaison rapide. */
export function signatureFingerprint(sig: SchemaSignature): string {
  const text = Object.keys(sig).sort().map((t) => `${t}(${[...sig[t]].sort().join(',')})`).join(';');
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

export interface CompatibilityResult {
  restorable: boolean;
  /** Motif lisible quand le point n'est pas restaurable. */
  reason: string | null;
  /** Tables réinjectées depuis le point. */
  restoredTables: string[];
  /** Tables conservées dans leur état courant. */
  keptTables: string[];
  differences: Array<{ table: string; issue: 'ABSENTE_DU_POINT' | 'ABSENTE_AUJOURD_HUI' | 'COLONNES_DIFFERENTES'; detail?: string }>;
}

/**
 * Compare la signature d'un point (manifeste v2) au schéma courant. Seules
 * les tables restaurées comptent ; les tables conservées peuvent différer.
 */
export function checkRestoreCompatibility(
  backup: { version: number; tables: Array<{ name: string; columns?: string[] }> },
  current: SchemaSignature,
  keep: readonly string[] = RESTORE_KEEP_CURRENT_TABLES,
): CompatibilityResult {
  const keepSet = new Set(keep);
  const res: CompatibilityResult = { restorable: false, reason: null, restoredTables: [], keptTables: [], differences: [] };
  if (backup.version !== 2 || backup.tables.some((t) => !Array.isArray(t.columns))) {
    res.reason = 'Sauvegarde au format antérieur au lot 82 (lignes lues hors instantané commun, valeurs converties) : '
      + 'restauration depuis le BO impossible. Créez un nouveau point de restauration.';
    return res;
  }
  const inBackup = new Map(backup.tables.map((t) => [t.name, [...(t.columns ?? [])].sort()]));
  for (const name of Object.keys(current).sort()) {
    if (keepSet.has(name)) { res.keptTables.push(name); continue; }
    const cols = inBackup.get(name);
    if (!cols) { res.differences.push({ table: name, issue: 'ABSENTE_DU_POINT' }); continue; }
    const now = [...current[name]].sort();
    if (cols.join(',') !== now.join(',')) {
      const missing = now.filter((c) => !cols.includes(c));
      const extra = cols.filter((c) => !now.includes(c));
      res.differences.push({
        table: name, issue: 'COLONNES_DIFFERENTES',
        detail: [missing.length ? `nouvelles : ${missing.join(', ')}` : '', extra.length ? `disparues : ${extra.join(', ')}` : ''].filter(Boolean).join(' ; '),
      });
      continue;
    }
    res.restoredTables.push(name);
  }
  for (const name of inBackup.keys()) {
    if (!keepSet.has(name) && !(name in current)) res.differences.push({ table: name, issue: 'ABSENTE_AUJOURD_HUI' });
  }
  if (res.differences.length) {
    res.restoredTables = [];
    res.reason = `Le schéma a changé depuis ce point (${res.differences.length} table(s) différente(s) : migration passée depuis). `
      + 'Restaurer réinjecterait des lignes dans une structure différente : refusé. Créez un point de restauration après le déploiement.';
    return res;
  }
  res.restorable = true;
  return res;
}
