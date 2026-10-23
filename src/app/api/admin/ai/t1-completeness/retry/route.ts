/**
 * POST /api/admin/ai/t1-completeness/retry — lot 53 (retour PO D19).
 *
 * Reprise MANUELLE d'un document en « vérification incomplète » depuis
 * BO › Exécutions IA › Complétude T1 : le document repasse dans la file T1
 * (relecture du fichier, traitement technique non facturé et non annoncé à
 * l'utilisateur). Tracée sur la ligne de couverture (dernière reprise :
 * `REQUEUED_T1_ADMIN`) et dans le journal. Corps : `{ fileId }`.
 * Refus : document inconnu (404), autre état que VERIFICATION_INCOMPLETE (409).
 *
 * Lot 84D (CDC Pilotage IA V2 BO-03, BO-10) : même reprise depuis le détail
 * d'une exécution métier — `businessExecutionId` optionnel ; journalisée
 * (`AI_EXECUTION_RELAUNCH` : acteur, document, exécution d'origine). La
 * reprise CONTINUE l'exécution (même identité, R22).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';
import { parseExecutionId } from '@/services/ai/business-execution/identity';
import { logAdminAction } from '@/lib/admin-audit';

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const body = (await req.json().catch(() => null)) as { fileId?: unknown; businessExecutionId?: unknown } | null;
  const fileId = Number(body?.fileId);
  const executionId = typeof body?.businessExecutionId === 'string' && parseExecutionId(body.businessExecutionId) ? body.businessExecutionId : null;
  if (!Number.isSafeInteger(fileId) || fileId <= 0) {
    return NextResponse.json({ error: 'INVALID_BODY', message: '`fileId` (entier) est requis.' }, { status: 400 });
  }
  try {
    const { sourceLayerReady } = await import('@/services/ai/source-analysis/source-units/repository');
    if (!(await sourceLayerReady())) return NextResponse.json({ error: 'UNAVAILABLE', message: 'Couche de couverture absente.' }, { status: 409 });
    const { pgClient } = await import('@/db');
    const [row] = (await pgClient.unsafe(
      `SELECT c.account_id, c.quality_state, c.retry_attempts FROM document_extraction_coverage c
         JOIN asset_files af ON af.id = c.file_id AND af.deleted_at IS NULL
        WHERE c.file_id = $1`,
      [fileId] as never[],
    )) as unknown as Array<{ account_id: number; quality_state: string; retry_attempts: number }>;
    if (!row) return NextResponse.json({ error: 'NOT_FOUND', message: 'Document introuvable.' }, { status: 404 });
    if (row.quality_state !== 'VERIFICATION_INCOMPLETE') {
      return NextResponse.json({ error: 'NOT_APPLICABLE', message: 'Reprise réservée aux vérifications incomplètes.' }, { status: 409 });
    }
    const { requeueDocumentForReread } = await import('@/services/ai/source-analysis/source-units/jobs');
    const queued = await requeueDocumentForReread({
      fileId, accountId: Number(row.account_id), attempt: Number(row.retry_attempts ?? 0) + 1,
      origin: 't1-completeness-retry', result: 'REQUEUED_T1_ADMIN',
    });
    await logAdminAction({
      adminId: guard.ctx.adminUserId, action: 'AI_EXECUTION_RELAUNCH', targetType: 'AI_EXECUTION', targetId: fileId, result: 'SUCCESS',
      details: { kind: 't1-completeness-retry', fileId, businessExecutionId: executionId, queued },
    });
    console.info(`[t1-completeness] reprise manuelle du document ${fileId} par l'administrateur ${guard.ctx.adminUserId} : ${queued ? 'mis en file' : 'déjà en file / refusé'}`);
    return NextResponse.json({ ok: true, queued });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/t1-completeness/retry');
  }
}
