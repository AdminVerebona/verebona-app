/**
 * État du compte pour les suggestions — CDC §8.2.
 *
 * Une seule requête, bornée au compte (§13.2), qui ne rend que des
 * compteurs : aucune donnée du compte ne quitte le serveur par ce chemin.
 */
import { pgClient } from '@/db';
import type { AccountSuggestionState } from '../registries/capability-registry';

export async function loadAccountSuggestionState(accountId: number): Promise<AccountSuggestionState> {
  const rows = (await pgClient.unsafe(
    `SELECT
       (SELECT count(*)::int FROM to_process_actions WHERE account_id = $1 AND resolved_at IS NULL) AS "toProcessPending",
       (SELECT count(*)::int FROM agenda_items
         WHERE account_id = $1 AND start_date >= current_date AND start_date <= current_date + 30) AS "deadlinesSoon",
       (SELECT count(*)::int FROM asset_files
         WHERE account_id = $1 AND deleted_at IS NULL AND analysis_state IN ('UPLOADING', 'UPLOADED', 'ANALYZING')) AS "documentsInAnalysis",
       (SELECT count(*)::int FROM asset_files
         WHERE account_id = $1 AND deleted_at IS NULL AND analysis_state = 'ANALYSIS_FAILED') AS "documentsFailed",
       (SELECT count(*)::int FROM export_generation WHERE account_id = $1 AND status = 'ready') AS "exportsReady"`,
    [accountId] as never[],
  )) as unknown as AccountSuggestionState[];
  const r = rows[0];
  return {
    toProcessPending: Number(r?.toProcessPending ?? 0),
    deadlinesSoon: Number(r?.deadlinesSoon ?? 0),
    documentsInAnalysis: Number(r?.documentsInAnalysis ?? 0),
    documentsFailed: Number(r?.documentsFailed ?? 0),
    exportsReady: Number(r?.exportsReady ?? 0),
  };
}
