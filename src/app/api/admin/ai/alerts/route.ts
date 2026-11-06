/**
 * GET /api/admin/ai/alerts — CDC BO IA ALT-01, WF-22, WF-44 : alertes système
 * (garde-fous, budgets, anomalies de coût), les plus récentes d'abord.
 * Paramètres : `open=1` (ni acquittées ni résolues), `resolved=1` (résolues,
 * lot 113O), `kind`, `treatment`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { listAlerts, type AlertKind } from '@/services/ai/alerts/alerts.repository';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

const KINDS: AlertKind[] = ['guardrail', 'budget', 'anomaly'];

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const p = new URL(req.url).searchParams;
  const kind = p.get('kind');
  try {
    const alerts = await listAlerts({
      openOnly: p.get('open') === '1',
      // Lot 113O : `resolved=1` — historique des alertes résolues (jamais supprimées).
      ...(p.get('resolved') === '1' ? { status: 'resolved' as const } : {}),
      kind: KINDS.includes(kind as AlertKind) ? (kind as AlertKind) : undefined,
      treatment: p.get('treatment') ?? undefined,
      limit: Number(p.get('limit')) || 50,
    });
    return NextResponse.json({ alerts });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/alerts');
  }
}
