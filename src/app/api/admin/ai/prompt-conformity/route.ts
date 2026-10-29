/**
 * /api/admin/ai/prompt-conformity — lot 99B (mise en conformité automatique
 * des prompts IA en préproduction).
 *
 *   GET                       vue Configuration IA › Conformité des prompts :
 *                             registre des contrats (état sur le prompt actif),
 *                             une entrée par incompatibilité (contrat, prompt,
 *                             cause, impact, correction, statut, couverture,
 *                             motifs de refus, rattrapage, anomalies
 *                             résiduelles, journal).
 *   POST { action: 'run' }    passage immédiat (tâche de fond, 202) — même
 *                             service que la tâche planifiée.
 *   POST { action: 'retry', issueId }
 *                             nouvel essai d'une incompatibilité bloquée, en
 *                             échec ou annulée (lève la garde d'empreinte).
 * Droits : administrateurs existants ; chaque geste est journalisé.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const { conformityOverview } = await import('@/services/ai/prompt-conformity/service');
    return NextResponse.json(await conformityOverview(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/prompt-conformity');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const body = (await req.json().catch(() => null)) as { action?: unknown; issueId?: unknown } | null;
    const svc = await import('@/services/ai/prompt-conformity/service');
    const { recordConfigAudit } = await import('@/services/ai/config/config-entry.audit');
    if (body?.action === 'run') {
      void svc.runPromptConformityPass({ trigger: `admin:${guard.ctx.adminUserId}` })
        .catch((e) => console.error('[prompt-conformity] passage demandé depuis le BO :', (e as Error).message));
      await recordConfigAudit('ai_prompt_conformity_run', guard.ctx.adminUserId, null, { requestedAt: new Date().toISOString() });
      return NextResponse.json({ status: 'STARTED' }, { status: 202 });
    }
    if (body?.action === 'retry' && typeof body.issueId === 'number' && Number.isInteger(body.issueId)) {
      try {
        const r = await svc.requestRetry(body.issueId, guard.ctx.adminUserId);
        await recordConfigAudit('ai_prompt_conformity_retry', guard.ctx.adminUserId, { issueId: r.id, status: r.status }, { retryRequestedAt: r.retryRequestedAt });
        return NextResponse.json({ issueId: r.id, retryRequestedAt: r.retryRequestedAt });
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 404 || status === 409) return NextResponse.json({ error: status === 404 ? 'NOT_FOUND' : 'NOT_RETRYABLE', message: (e as Error).message }, { status });
        throw e;
      }
    }
    return NextResponse.json({ error: 'INVALID_REQUEST', message: 'Action attendue : { action: "run" } ou { action: "retry", issueId }.' }, { status: 400 });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/prompt-conformity');
  }
}
