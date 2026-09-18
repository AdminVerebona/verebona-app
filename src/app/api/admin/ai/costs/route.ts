/**
 * GET /api/admin/ai/costs — CDC BO IA SCR-09.
 *
 * Synthèse et ventilations des dépenses IA sur une période.
 *
 * ── AUCUNE SUSPENSION BUDGÉTAIRE ───────────────────────────────────────────
 * Le SCR-09 est net : « une alerte de coût ne suspend jamais automatiquement un
 * traitement ». Cette route ne fait donc que mesurer. Couper un traitement sur
 * un dépassement transformerait un incident de facturation en panne produit, et
 * personne ne saurait pourquoi l'analyse documentaire s'est arrêtée.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCostReport, averageCostPerCall } from '@/services/ai/telemetry/cost-report.repository';
import { isTreatment } from '@/services/ai/config/treatments';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

/** Périodes du SCR-09, en jours. `custom` passe par `since` et `until`. */
const PERIODS: Record<string, number> = {
  today: 1, '7d': 7, '30d': 30, month: 30, year: 365,
};

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const p = new URL(req.url).searchParams;
  const period = p.get('period') ?? '30d';
  const treatment = p.get('treatment');
  const accountId = p.get('accountId');

  const parseDate = (v: string | null): Date | undefined => {
    if (!v) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };

  const until = parseDate(p.get('until')) ?? new Date();
  const since = parseDate(p.get('since'))
    ?? new Date(until.getTime() - (PERIODS[period] ?? 30) * 86_400_000);

  try {
    const report = await getCostReport({
      since, until,
      treatment: treatment && isTreatment(treatment) ? treatment : undefined,
      accountId: accountId && /^\d+$/.test(accountId) ? Number(accountId) : undefined,
    });

    return NextResponse.json({
      ...report,
      averageCostPerCall: averageCostPerCall(report.totals),
      // Signalé explicitement : le SCR-09 demande de « signaler l'incomplétude »
      // plutôt que de rendre un agrégat qui paraîtrait exact.
      warning: report.incomplete
        ? `${report.totals.unpricedCalls} appel(s) sans tarif connu : le total est incomplet.`
        : null,
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/costs');
  }
}
