/**
 * GET /api/admin/ai/t6-efficiency?from=AAAA-MM-JJ&to=AAAA-MM-JJ — lot 113AO
 * (Trello #748, AC15) : mesure des appels T6 de la période (appels FORMULATE
 * par code de signal, jetons, sorties identiques au texte déterministe,
 * générations évitées, doublons, rattachement des appels, causes d'échec).
 * Administrateur seulement ; des nombres, jamais de texte. Défaut : 7 jours.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

const JOUR = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const p = new URL(req.url).searchParams;
  const to = JOUR.test(p.get('to') ?? '') ? new Date(`${p.get('to')}T23:59:59.999Z`) : new Date();
  const from = JOUR.test(p.get('from') ?? '') ? new Date(`${p.get('from')}T00:00:00.000Z`) : new Date(to.getTime() - 7 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    return NextResponse.json({ error: 'Période invalide.' }, { status: 400 });
  }
  try {
    const [{ pgClient }, { t6EfficiencyReport }] = await Promise.all([import('@/db'), import('@/services/home/mascot/t6-efficiency-report')]);
    const q = async (sql: string, params?: unknown[]) => (await pgClient.unsafe(sql, (params ?? []) as never[])) as unknown as Array<Record<string, unknown>>;
    const report = await t6EfficiencyReport(q, { from, to });
    return NextResponse.json(report, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    return toErrorResponse(e, '/api/admin/ai/t6-efficiency');
  }
}
