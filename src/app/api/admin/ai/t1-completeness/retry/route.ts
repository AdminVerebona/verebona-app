/**
 * POST /api/admin/ai/t1-completeness/retry — lot 53 (retour PO D19).
 *
 * Reprise MANUELLE d'un document en « vérification incomplète » depuis
 * BO › Exécutions IA › Complétude T1 : le document repasse dans la file T1
 * (relecture du fichier, traitement technique non facturé et non annoncé à
 * l'utilisateur). Tracée sur la ligne de couverture (dernière reprise :
 * `REQUEUED_T1_ADMIN`) et dans le journal. Corps : `{ fileId }`.
 * Refus : document inconnu (404), autre état que VERIFICATION_INCOMPLETE (409).
 * Lot 114H (Trello #775, P1-B) : mise en file NON confirmée par la file T1
 * (compte non éligible, refus transitoire ou définitif) → 409 `NOT_QUEUED` avec
 * le statut réel ; un travail déjà vivant est rendu `alreadyRunning`.
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

/** Lot 114H (#775) : message d'une remise en file NON confirmée (textes nouveaux, à valider par le PO). */
const REQUEUE_REFUSAL_MESSAGE: Record<string, string> = {
  ACCOUNT_NOT_ELIGIBLE: 'Analyse non relancée : le compte n’est pas éligible au traitement.',
  REJECTED_TRANSIENT: 'Analyse non relancée : la file d’analyse a refusé la demande (erreur passagère). Réessayer dans quelques minutes.',
  REJECTED_FINAL: 'Analyse non relancée : la file d’analyse a refusé la demande (refus définitif). Voir la Supervision.',
};

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
    // Lot 114H (#775, P1-B) : l'issue RÉELLE de la file est rendue — plus de « ok » pour une mise en file refusée.
    const { requeueDocumentForRereadDetailed } = await import('@/services/ai/source-analysis/source-units/jobs');
    const r = await requeueDocumentForRereadDetailed({
      fileId, accountId: Number(row.account_id), attempt: Number(row.retry_attempts ?? 0) + 1,
      origin: 't1-completeness-retry', result: 'REQUEUED_T1_ADMIN',
    });
    await logAdminAction({
      adminId: guard.ctx.adminUserId, action: 'AI_EXECUTION_RELAUNCH', targetType: 'AI_EXECUTION', targetId: fileId, result: r.queued ? 'SUCCESS' : 'FAILURE',
      details: { kind: 't1-completeness-retry', fileId, businessExecutionId: executionId, queued: r.queued, status: r.status, reason: r.reason, jobId: r.jobId },
    });
    console.info(`[t1-completeness] reprise manuelle du document ${fileId} par l'administrateur ${guard.ctx.adminUserId} : ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
    if (!r.queued) {
      return NextResponse.json({ ok: false, queued: false, status: r.status, reason: r.reason, error: 'NOT_QUEUED', message: REQUEUE_REFUSAL_MESSAGE[r.status] ?? 'Mise en file refusée.' }, { status: 409 });
    }
    return NextResponse.json({ ok: true, queued: true, status: r.status, alreadyRunning: r.status === 'ALREADY_RUNNING', jobId: r.jobId });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/t1-completeness/retry');
  }
}
