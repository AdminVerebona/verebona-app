/**
 * GET/PUT /api/admin/ai/cost-settings — CDC BO IA COST-010, COST-012,
 * CST-UI-08, CST-UI-09.
 *
 * Budgets mensuels global et T1–T6 (en unités de la devise de la grille
 * tarifaire côté API — USD aujourd'hui, comme l'écran Coûts —, micro-unités
 * en base, comparables directement à `ai_usage_event.cost_micros`)
 * et activation de la détection d'anomalies. Paramètre opérationnel local à
 * l'environnement : hors version, hors package. Aucun réglage statistique
 * (COST-012) ; aucun budget par compte (COST-010).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCostSettings, saveCostSettings } from '@/services/ai/alerts/cost-evaluator';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const s = await getCostSettings();
    return NextResponse.json({
      anomaliesEnabled: s.anomaliesEnabled,
      budgets: s.budgets.map((b) => ({ scope: b.scope, monthlyBudget: b.monthlyBudgetMicros == null ? null : b.monthlyBudgetMicros / 1_000_000 })),
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/cost-settings');
  }
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const body = await req.json().catch(() => null) as {
    budgets?: Array<{ scope: string; monthlyBudget: number | null }>; anomaliesEnabled?: boolean;
  } | null;
  if (!body) return NextResponse.json({ error: 'INVALID_BODY' }, { status: 400 });
  for (const b of body.budgets ?? []) {
    if (b.monthlyBudget != null && (typeof b.monthlyBudget !== 'number' || !Number.isFinite(b.monthlyBudget) || b.monthlyBudget < 0)) {
      return NextResponse.json({ error: 'INVALID_BUDGET', message: `Budget invalide pour ${b.scope}.` }, { status: 400 });
    }
  }
  try {
    await saveCostSettings({
      anomaliesEnabled: typeof body.anomaliesEnabled === 'boolean' ? body.anomaliesEnabled : undefined,
      budgets: body.budgets?.map((b) => ({
        scope: b.scope,
        monthlyBudgetMicros: b.monthlyBudget == null ? null : Math.round(b.monthlyBudget * 1_000_000),
      })),
    }, guard.ctx.adminUserId);
    return NextResponse.json({ saved: true });
  } catch (e) {
    if (/inconnu|invalide/i.test((e as Error).message)) {
      return NextResponse.json({ error: 'INVALID_BUDGET', message: (e as Error).message }, { status: 400 });
    }
    return toErrorResponse(e, 'PUT /api/admin/ai/cost-settings');
  }
}
