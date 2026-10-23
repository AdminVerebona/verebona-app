/**
 * POST /api/assets/[id]/usage-budgets — ajoute un forfait d'usage (lot 54D,
 * TCO §3.5) : budget estimé (carburant, recharge, péages, autre), jamais un
 * coût réel ni une Opération. Premium / Premium Duo (droit d'écriture du
 * compte) ; Standard → 403 `PREMIUM_REQUIRED`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { canUsePremiumFeature } from '@/services/entitlements.service';
import { notFound, parsePositiveId, writableAssetOr } from '@/services/assets/asset-route-helpers';
import { createUsageBudget } from '@/services/business-operations/tco/service';
import { parseUsageBudgetBody } from '@/services/business-operations/tco/dto';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  try {
    const session = await SessionService.getSession(request);
    const assetId = parsePositiveId((await params).id);
    if (!assetId) return NextResponse.json({ error: 'INVALID_ID', code: 'INVALID_ASSET' }, { status: 400 });
    if (!session.currentAccountId) return notFound();
    const accountId = session.currentAccountId;
    const droit = await canUsePremiumFeature(accountId);
    if (!droit.allowed) return NextResponse.json({ error: droit.reason ?? 'PREMIUM_REQUIRED', code: droit.reason ?? 'PREMIUM_REQUIRED', message: droit.message }, { status: 403 });
    const w = await writableAssetOr(assetId, accountId);
    if ('response' in w) return w.response;
    let body: unknown = null;
    try { body = await request.json(); } catch { body = null; }
    const p = parseUsageBudgetBody(body);
    if (!p.ok) return NextResponse.json({ error: 'VALIDATION', code: 'VALIDATION', message: p.message }, { status: 422 });
    const id = await createUsageBudget(accountId, assetId, session.userId ?? null, p.value);
    if (!id) return notFound();
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    console.error('[tco] POST forfait :', (error as Error).message);
    return NextResponse.json({ error: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
