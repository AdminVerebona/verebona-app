/**
 * PATCH  /api/assets/[id]/usage-budgets/[budgetId] — modifie un forfait d'usage
 * DELETE /api/assets/[id]/usage-budgets/[budgetId] — le supprime (geste explicite)
 * (lot 54D, TCO §3.5). Premium / Premium Duo ; Standard → 403.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { canUsePremiumFeature } from '@/services/entitlements.service';
import { notFound, parsePositiveId, writableAssetOr } from '@/services/business-operations/claims/claim-route';
import { deleteUsageBudget, updateUsageBudget } from '@/services/business-operations/tco/service';
import { parseUsageBudgetBody } from '@/services/business-operations/tco/dto';

type Ctx = { params: Promise<{ id: string; budgetId: string }> };

async function garde(request: NextRequest, params: Ctx['params']) {
  const session = await SessionService.getSession(request);
  const p = await params;
  const assetId = parsePositiveId(p.id);
  const budgetId = parsePositiveId(p.budgetId);
  if (!assetId || !budgetId) return { response: NextResponse.json({ error: 'INVALID_ID', code: 'INVALID_ID' }, { status: 400 }) };
  if (!session.currentAccountId) return { response: notFound() };
  const droit = await canUsePremiumFeature(session.currentAccountId);
  if (!droit.allowed) return { response: NextResponse.json({ error: droit.reason ?? 'PREMIUM_REQUIRED', code: droit.reason ?? 'PREMIUM_REQUIRED', message: droit.message }, { status: 403 }) };
  const w = await writableAssetOr(assetId, session.currentAccountId);
  if ('response' in w) return { response: w.response };
  return { accountId: session.currentAccountId, userId: session.userId ?? null, assetId, budgetId };
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    const g = await garde(request, params);
    if ('response' in g) return g.response;
    let body: unknown = null;
    try { body = await request.json(); } catch { body = null; }
    const p = parseUsageBudgetBody(body);
    if (!p.ok) return NextResponse.json({ error: 'VALIDATION', code: 'VALIDATION', message: p.message }, { status: 422 });
    if (!(await updateUsageBudget(g.accountId, g.assetId, g.budgetId, g.userId, p.value))) return notFound();
    return NextResponse.json({ id: g.budgetId });
  } catch (error) {
    console.error('[tco] PATCH forfait :', (error as Error).message);
    return NextResponse.json({ error: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  try {
    const g = await garde(request, params);
    if ('response' in g) return g.response;
    if (!(await deleteUsageBudget(g.accountId, g.assetId, g.budgetId))) return notFound();
    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error('[tco] DELETE forfait :', (error as Error).message);
    return NextResponse.json({ error: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
