/**
 * Suivi des imports du partage natif — lot 110A.
 *
 * Lu par l'application ouverte (session habituelle) pour l'écran de suivi
 * « et ouvrir » et la carte d'état : pour chaque identifiant d'import tiré
 * par le téléphone, l'état SERVEUR du document — jamais celui d'un autre
 * utilisateur ou d'un autre espace (un identifiant inconnu ou étranger est
 * rendu « pas encore reçu », sans rien révéler).
 */
import { pgClient } from '@/db';
import { estCleOperation } from '@/lib/upload-idempotence';
import type { ProcessingStatus } from '@/lib/ai/processing-status';

export const SHARE_IMPORT_STATUS_MAX_IDS = 50;

export type ServerImportState =
  | { operationId: string; state: 'not_received' }
  | { operationId: string; state: 'receiving'; fileId: number }
  | { operationId: string; state: 'imported'; fileId: number; title: string | null; processingStatus: ProcessingStatus | null }
  | { operationId: string; state: 'deleted' };

/** Liste d'identifiants valides, dédoublonnée et bornée (pure). */
export function parseOperationIds(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const v of (raw ?? '').split(',').map((s) => s.trim())) {
    if (estCleOperation(v) && !out.includes(v)) out.push(v);
    if (out.length >= SHARE_IMPORT_STATUS_MAX_IDS) break;
  }
  return out;
}

export async function shareImportStatuses(userId: number, accountId: number, operationIds: string[]): Promise<ServerImportState[]> {
  if (operationIds.length === 0) return [];
  const rows = await pgClient`
    SELECT id, upload_operation_id, upload_status, deleted_at, COALESCE(retained_title, original_filename) AS title,
           analysis_state, analysis_fail_reason
    FROM asset_files
    WHERE user_id = ${userId} AND account_id = ${accountId} AND upload_operation_id IN ${pgClient(operationIds)}`;
  const byOp = new Map(rows.map((r) => [String(r.upload_operation_id), r]));
  const completed = rows.filter((r) => r.upload_status === 'COMPLETED' && !r.deleted_at);
  let views = new Map<number, { processingStatus: ProcessingStatus }>();
  if (completed.length > 0) {
    const { getProcessingViews } = await import('@/services/ai/processing-status/processing-status.service');
    views = await getProcessingViews(completed.map((r) => ({
      id: Number(r.id),
      analysisState: (r.analysis_state as string | null) ?? null,
      analysisFailReason: (r.analysis_fail_reason as string | null) ?? null,
    })));
  }
  return operationIds.map((operationId): ServerImportState => {
    const r = byOp.get(operationId);
    if (!r) return { operationId, state: 'not_received' };
    if (r.deleted_at) return { operationId, state: 'deleted' };
    if (r.upload_status !== 'COMPLETED') return { operationId, state: 'receiving', fileId: Number(r.id) };
    return {
      operationId, state: 'imported', fileId: Number(r.id), title: (r.title as string | null) ?? null,
      processingStatus: views.get(Number(r.id))?.processingStatus ?? null,
    };
  });
}
