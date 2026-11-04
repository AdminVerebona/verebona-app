/**
 * GET /api/admin/ai/costs/unpriced — lot 109L (ticket P1 « Tarifs Gemini non
 * reconnus, 948 appels », point D/E) : détail « Appels non chiffrés » du
 * bandeau de l'écran Coûts IA.
 *
 * Diagnostic produit PAR L'APPLICATION, en lecture seule, sur la période
 * demandée (défaut : celle de l'écran, 30 jours glissants) : rapprochement avec
 * l'ancienne règle du bandeau, répartition par jour / traitement / modèle /
 * compte (identifiant interne) / statut / cause, exemples reliés aux
 * exécutions, agrégats journaliers à part, dernier état de la synchronisation
 * tarifaire. `?format=txt` : rendu lisible à recopier dans la recette.
 * Aucun appel modèle, aucune écriture.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pgClient } from '@/db';
import { aiCostDiagnostic, costDiagnosticText, type Query } from '@/services/ai/telemetry/cost-diagnostic';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

const PERIODS: Record<string, number> = { today: 1, '7d': 7, '30d': 30, year: 365 };

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const p = new URL(req.url).searchParams;
  const parse = (v: string | null) => { if (!v) return undefined; const d = new Date(v); return Number.isNaN(d.getTime()) ? undefined : d; };
  const until = parse(p.get('until')) ?? new Date();
  const period = p.get('period') ?? '30d';
  const since = parse(p.get('since'))
    ?? (period === 'month' ? new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), 1)) : new Date(until.getTime() - (PERIODS[period] ?? 30) * 86_400_000));
  const accountId = p.get('accountId');
  try {
    const q: Query = async (t, params) => (await pgClient.unsafe(t, params as never[])) as unknown as Array<Record<string, unknown>>;
    const report = await aiCostDiagnostic(q, { since, until, accounts: accountId && /^\d+$/.test(accountId) ? [Number(accountId)] : null });
    if (p.get('format') === 'txt') {
      return new NextResponse(costDiagnosticText(report), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return NextResponse.json(report, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/costs/unpriced');
  }
}
