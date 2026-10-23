/**
 * GET /api/admin/ai/business-executions — lots 83C, 84D (CDC Pilotage IA V2
 * P2 et P3 : SEM-02 à SEM-06, OP-04, BO-01, BO-02, BO-04, BO-05, BO-07,
 * BO-08, R24, R60).
 *
 * Journal complet des exécutions MÉTIER (vue métier) ou TECHNIQUES (vue
 * technique) de la période, qualifiées depuis les états natifs, et les deux
 * cartes « Échecs » / « Incomplètes » — UN SEUL calcul (`journal.ts`) : la
 * carte, la liste filtrée sur son issue et l'export ont les mêmes nombres et
 * les mêmes identifiants. Aucun contenu sensible (ni prompt ni réponse) :
 * droit administrateur existant (décision PO 15).
 *
 * Paramètres : `days` (défaut 7) ou `from` / `to` (AAAA-MM-JJ, Paris) ;
 * `treatment` ; `outcome` ; `nature` (BUSINESS par défaut | TECHNICAL | all) ;
 * `origin` ; `accountId` ; `limit` (≤ 200), `offset`. La règle de période et
 * l'instant de lecture sont rendus avec la réponse.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';
import { callsOfExecutions, projectBusinessExecutions, summarize } from '@/services/ai/business-execution/repository';
import { BUSINESS_TREATMENTS } from '@/services/ai/business-execution/types';
import { toExecutionDto } from '@/services/ai/business-execution/dto';
import { cardCounts, compareJournal, matchesJournalFilter, parseJournalFilter } from '@/services/ai/business-execution/journal';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const p = new URL(req.url).searchParams;
  const now = new Date();
  const f = parseJournalFilter(p, now);
  const limit = Math.min(200, Math.max(1, Number(p.get('limit')) || 50));
  const offset = Math.max(0, Number(p.get('offset')) || 0);
  try {
    const treatments = f.treatment ? [f.treatment] : undefined;
    const proj = await projectBusinessExecutions({ from: f.period.from, to: f.period.to, treatments, accountId: f.accountId }, now);
    // Récapitulatif : toutes issues (BO-04), technique compté à part.
    const summary = summarize(proj.rows, treatments ?? BUSINESS_TREATMENTS);
    const filtered = proj.rows.filter((r) => matchesJournalFilter(r, f)).sort(compareJournal);
    const page = filtered.slice(offset, offset + limit);
    const calls = await callsOfExecutions(page).catch(() => new Map());
    return NextResponse.json({
      readAt: now.toISOString(),
      period: { from: f.period.from.toISOString(), to: f.period.to.toISOString(), rule: f.period.rule, timeZone: 'Europe/Paris' },
      cards: cardCounts(proj.rows, f),
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
