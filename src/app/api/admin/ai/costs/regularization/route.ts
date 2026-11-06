/**
 * /api/admin/ai/costs/regularization — lot 109L (ticket P1 « Tarifs Gemini »,
 * point D) : régularisation CONTRÔLÉE des coûts non chiffrés.
 *
 * GET  : exécutions récentes (simulations, applications, retours arrière).
 * POST : `{ action: 'dry_run', since, until }` — simulation, rien n'est modifié ;
 *        `{ action: 'apply', dryRunId, confirm: true }` — application UNIQUE de
 *        la simulation (refusée si le plan a changé ou déjà appliquée) ;
 *        `{ action: 'revert', applyRunId, reason }` — retour arrière.
 * Le coût et la référence tarifaire initiaux des traces ne sont jamais
 * modifiés ; aucune IA n'est appelée. Chaque geste est journalisé
 * (journal d'administration, mêmes types que les rattrapages d'exploitation).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logAdminAction } from '@/lib/admin-audit';
import {
  applyRegularization, dryRunRegularization, listRegularizationRuns, revertRegularization,
} from '@/services/ai/telemetry/cost-regularization';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json({ runs: await listRegularizationRuns(20) }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/costs/regularization');
  }
}

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('dry_run'), since: z.string().datetime({ offset: true }), until: z.string().datetime({ offset: true }) }),
  z.object({ action: z.literal('apply'), dryRunId: z.number().int().positive(), confirm: z.literal(true) }),
  z.object({ action: z.literal('revert'), applyRunId: z.number().int().positive(), reason: z.string().trim().min(5).max(300) }),
]);

const MAX_DAYS = 400;

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'INVALID_BODY', message: 'Requête invalide.' }, { status: 400 });
  const b = parsed.data;
  const adminId = guard.ctx.adminUserId;
  try {
    if (b.action === 'dry_run') {
      const since = new Date(b.since); const until = new Date(b.until);
      if (!(since < until) || until.getTime() - since.getTime() > MAX_DAYS * 86_400_000) {
        return NextResponse.json({ error: 'INVALID_PERIOD', message: `Période invalide (au plus ${MAX_DAYS} jours).` }, { status: 400 });
      }
      const r = await dryRunRegularization({ since, until }, adminId);
      await logAdminAction({ adminId, action: 'OPS_BACKFILL_SIMULATE', targetType: 'OPS_BACKFILL', targetId: r.runId, result: 'SUCCESS',
        details: { scope: 'ai-cost-regularization', since: b.since, until: b.until, fingerprint: r.fingerprint, summary: r.summary } });
      return NextResponse.json(r);
    }
    if (b.action === 'apply') {
      const r = await applyRegularization(b.dryRunId, adminId);
      await logAdminAction({ adminId, action: 'OPS_BACKFILL_APPLY', targetType: 'OPS_BACKFILL', targetId: r.runId, result: r.refused ? 'FAILURE' : 'SUCCESS',
        details: { scope: 'ai-cost-regularization', dryRunId: b.dryRunId, refused: r.refused ?? null, summary: r.summary } });
      // Lot 113O : recontrôle des alertes tarifaires (appels régularisés → alerte résolue).
      if (!r.refused) await (await import('@/services/ai/gateway/pricing/pricing-supervision')).reconcilePricingAlerts('regularization-apply');
      return NextResponse.json(r, { status: r.refused ? 409 : 200 });
    }
    const r = await revertRegularization(b.applyRunId, adminId);
    await logAdminAction({ adminId, action: 'OPS_BACKFILL_RESTORE', targetType: 'OPS_BACKFILL', targetId: r.runId, result: r.refused ? 'FAILURE' : 'SUCCESS',
      details: { scope: 'ai-cost-regularization', applyRunId: b.applyRunId, reason: b.reason, summary: r.summary } });
    if (!r.refused) await (await import('@/services/ai/gateway/pricing/pricing-supervision')).reconcilePricingAlerts('regularization-revert');
    return NextResponse.json(r, { status: r.refused ? 404 : 200 });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/costs/regularization');
  }
}
