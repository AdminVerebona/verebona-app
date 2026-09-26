import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { parsePeriodKind, parseRef, resolvePeriod } from '@/lib/admin/periods';
import { getActivity, getCommercial, getOverview } from '@/services/admin/kpi.service';
import { checkBackupFreshness, getSupervisionCounters } from '@/services/admin/anomaly.service';
import { latestBackupAt } from '@/services/backup/database-backup.service';

/**
 * GET /api/admin/dashboard?view=overview|activity|commercial|supervision
 *                          &period=month|quarter|semester|year&ref=YYYY-MM-DD
 *
 * Dashboard back-office — CDC Back-Office V1 §4.
 *  - overview / activity / commercial : KPI de la période calendaire choisie
 *    (Mois par défaut, DASH-003) et comparaison à la précédente (DASH-004).
 *  - supervision : compteur global et compteurs par domaine (SUP-001/002).
 *    La liste des anomalies est servie par `/api/admin/anomalies`.
 *
 * ERR-001 : une source en échec fait échouer toute la vue (500) — jamais de
 * KPI partiel présenté comme complet. L'écran propose « Réessayer ».
 *
 * Une période future est ramenée à la période en cours : il n'y a rien à y
 * mesurer et un stock « à la fin de décembre prochain » serait une fiction.
 */

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);

    const params = request.nextUrl.searchParams;
    const view = params.get('view') ?? 'overview';

    if (view === 'supervision') {
      // Contrôle de fraîcheur des sauvegardes (absorbées dans la
      // Supervision, CDC BO §15) avant de compter.
      await checkBackupFreshness(await latestBackupAt());
      return NextResponse.json(await getSupervisionCounters());
    }

    const now = new Date();
    const kind = parsePeriodKind(params.get('period'));
    let period = resolvePeriod(kind, parseRef(params.get('ref'), now), now);
    if (period.future) period = resolvePeriod(kind, parseRef(null, now), now);

    switch (view) {
      case 'overview': return NextResponse.json(await getOverview(period));
      case 'activity': return NextResponse.json(await getActivity(period));
      case 'commercial': return NextResponse.json(await getCommercial(period));
      default:
        return NextResponse.json({ error: 'Vue inconnue', code: 'INVALID_VIEW' }, { status: 400 });
    }
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    const message = error instanceof Error ? error.message : String(error);
    console.error('[admin/dashboard] erreur :', message, error);
    return NextResponse.json(
      { error: 'Chargement du tableau de bord impossible', message, code: 'DASHBOARD_LOAD_FAILED' },
      { status: 500 },
    );
  }
}
