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
    // Lot 113I (CDC V2 BO-04/05, BUD-01) : budget d'AMÉLIORATION (EUR, distinct des budgets métier ci-dessus) et
    // politique administrée — lecture.
    const [{ budgetSummary }, { loadPolicy, policyHistory, POLICY_SUGGESTIONS, POLICY_BOUNDS }] = await Promise.all([
      import('@/services/ai/qualification/improvement-budget'), import('@/services/ai/qualification/improvement-policy'),
    ]);
    const [improvementBudget, improvementPolicy, history] = await Promise.all([budgetSummary(), loadPolicy(), policyHistory()]);
    return NextResponse.json({
      anomaliesEnabled: s.anomaliesEnabled,
      budgets: s.budgets.map((b) => ({ scope: b.scope, monthlyBudget: b.monthlyBudgetMicros == null ? null : b.monthlyBudgetMicros / 1_000_000 })),
      improvement: { budget: improvementBudget, policy: improvementPolicy, history, suggestions: POLICY_SUGGESTIONS, bounds: POLICY_BOUNDS },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/cost-settings');
  }
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const body = await req.json().catch(() => null) as {
    budgets?: Array<{ scope: string; monthlyBudget: number | null }>; anomaliesEnabled?: boolean;
    /** Lot 113I : politique d'amélioration — révision attendue (APIX-001) et motif (audit) obligatoires. */
    improvementPolicy?: unknown; expectedVersion?: number; reason?: string;
  } | null;
  if (!body) return NextResponse.json({ error: 'INVALID_BODY' }, { status: 400 });
  if (body.improvementPolicy !== undefined) {
    const { savePolicy, PolicyRefused } = await import('@/services/ai/qualification/improvement-policy');
    if (!Number.isInteger(body.expectedVersion)) return NextResponse.json({ error: 'POLICY_INVALID', message: 'Révision attendue (expectedVersion) obligatoire.' }, { status: 400 });
    try {
      const r = await savePolicy({ input: body.improvementPolicy, expectedVersion: body.expectedVersion!, userId: guard.ctx.adminUserId, reason: String(body.reason ?? '') });
      if (r.changed) {
        const { recordConfigAudit } = await import('@/services/ai/config/config-entry.audit');
        await recordConfigAudit('ai_improvement_policy_update', guard.ctx.adminUserId, { version: body.expectedVersion }, { version: r.policy.version, sha256: r.policy.sha256, reason: String(body.reason ?? '').slice(0, 300) }).catch(() => undefined);
      }
      return NextResponse.json({ saved: r.changed, policy: r.policy, impacts: r.impacts });
    } catch (e) {
      if (e instanceof PolicyRefused) return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === 'POLICY_CONFLICT' ? 409 : 400 });
      return toErrorResponse(e, 'PUT /api/admin/ai/cost-settings (politique)');
    }
  }
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
