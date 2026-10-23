/**
 * GET /api/admin/ai/business-executions — lot 83C (CDC Pilotage IA V2 P2 :
 * SEM-02 à SEM-06, OP-04, BO-04, BO-05).
 *
 * Exécutions MÉTIER de la période, qualifiées depuis les états natifs
 * (Réussie / Incomplète / Échouée / non finale, résultat natif, cause,
 * nature, origine), et récapitulatif par traitement — chaque exécution
 * comptée une fois, selon son issue actuelle. Aucun contenu sensible (ni
 * prompt ni réponse) : droit administrateur existant (`requireAdmin`,
 * décision PO 15), comme la liste des appels.
 *
 * Paramètres : `days` (défaut 7) ou `from` / `to` (AAAA-MM-JJ, Paris) ;
 * `treatment` (T1…T6) ; `accountId` ; `nature` (BUSINESS | TECHNICAL,
 * défaut BUSINESS ; `all`) ; `outcome` ; `limit` (≤ 200), `offset`.
 * La règle de période est rendue avec la réponse (`period.rule`), ainsi que
 * l'instant de lecture (`readAt`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';
import { periodFromQuery } from '@/services/ai/business-execution/period';
import { callsOfExecutions, projectBusinessExecutions, summarize } from '@/services/ai/business-execution/repository';
import { BUSINESS_OUTCOMES, BUSINESS_TREATMENTS, type BusinessNature, type BusinessOutcome, type BusinessTreatment } from '@/services/ai/business-execution/types';
import { toExecutionDto } from '@/services/ai/business-execution/dto';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const p = new URL(req.url).searchParams;
  const now = new Date();
  const period = periodFromQuery({ days: p.get('days'), from: p.get('from'), to: p.get('to') }, now);
  const treatment = p.get('treatment');
  const treatments = treatment && (BUSINESS_TREATMENTS as readonly string[]).includes(treatment) ? [treatment as BusinessTreatment] : undefined;
  const acc = p.get('accountId');
  const accountId = acc && /^\d{1,10}$/.test(acc) ? Number(acc) : null;
  const natureRaw = p.get('nature');
  const nature: BusinessNature | null = natureRaw === 'all' ? null : natureRaw === 'TECHNICAL' ? 'TECHNICAL' : 'BUSINESS';
  const outcomeRaw = p.get('outcome');
  const outcome = outcomeRaw && (BUSINESS_OUTCOMES as readonly string[]).includes(outcomeRaw) ? outcomeRaw as BusinessOutcome : null;
  const limit = Math.min(200, Math.max(1, Number(p.get('limit')) || 50));
  const offset = Math.max(0, Number(p.get('offset')) || 0);
  try {
    const proj = await projectBusinessExecutions({ from: period.from, to: period.to, treatments, accountId }, now);
    // Récapitulatif : toutes issues (BO-04), technique compté à part.
    const summary = summarize(proj.rows, treatments ?? BUSINESS_TREATMENTS);
    const filtered = proj.rows.filter((r) => (!nature || r.nature === nature) && (!outcome || r.outcome === outcome));
    const page = filtered.slice(offset, offset + limit);
    const calls = await callsOfExecutions(page).catch(() => new Map());
    return NextResponse.json({
      readAt: now.toISOString(),
      period: { from: period.from.toISOString(), to: period.to.toISOString(), rule: period.rule },
      summary,
      total: filtered.length,
      rows: page.map((r) => toExecutionDto(r, calls.get(r.id) ?? null)),
      truncated: proj.truncated,
      unavailable: proj.unavailable,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/business-executions');
  }
}
