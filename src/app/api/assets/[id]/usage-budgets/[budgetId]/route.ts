/**
 * PATCH  /api/assets/[id]/usage-budgets/[budgetId] — modifie un forfait d'usage
 * DELETE /api/assets/[id]/usage-budgets/[budgetId] — l'arrête ou le supprime (geste explicite)
 * (lot 54D, TCO §3.5). Premium / Premium Duo ; Standard → 403.
 *
 * Lot 108C : PATCH accepte `effectiveFrom` (AAAA-MM-JJ, facultatif) — une
 * modification de montant / devise / périodicité / catégorie crée une version
 * datée (les périodes closes gardent l'ancien montant) ; réponse
 * `{ id, revised, effectiveFrom }`. DELETE `?mode=STOP` termine le forfait à
 * la fin de la dernière période échue ; `?mode=ERASE_HISTORY` supprime toutes
 * ses versions ; défaut `ERASE` (cette version). Chevauchement → 409.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { canUsePremiumFeature } from '@/services/entitlements.service';
import { notFound, parsePositiveId, writableAssetOr } from '@/services/assets/asset-route-helpers';
import {
  deleteUsageBudget, parseEffectiveFrom, parseUsageBudgetDeleteMode, updateUsageBudget, UsageBudgetError,
} from '@/services/business-operations/tco/usage-budgets.service';
import { parseUsageBudgetBody } from '@/services/business-operations/tco/dto';

type Ctx = { params: Promise<{ id: string; budgetId: string }> };

type Garde = { response: NextResponse } | { accountId: number; userId: number | null; assetId: number; budgetId: number };

async function garde(request: NextRequest, params: Ctx['params']): Promise<Garde> {
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
    const e = parseEffectiveFrom(body);
    if (!e.ok) return NextResponse.json({ error: 'VALIDATION', code: 'VALIDATION', message: e.message }, { status: 422 });
    const r = await updateUsageBudget(g.accountId, g.assetId, g.budgetId, g.userId, p.value, { effectiveFrom: e.value });
    if (!r) return notFound();
    return NextResponse.json(r);
  } catch (error) {
    if (error instanceof UsageBudgetError) return NextResponse.json({ error: error.code, code: error.code, message: error.message }, { status: error.status });
    console.error('[tco] PATCH forfait :', (error as Error).message);
    return NextResponse.json({ error: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  try {
    const g = await garde(request, params);
    if ('response' in g) return g.response;
    const mode = parseUsageBudgetDeleteMode(request.nextUrl.searchParams.get('mode'));
    if (!(await deleteUsageBudget(g.accountId, g.assetId, g.budgetId, mode))) return notFound();
    return NextResponse.json({ deleted: true, mode });
  } catch (error) {
    console.error('[tco] DELETE forfait :', (error as Error).message);
    return NextResponse.json({ error: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
