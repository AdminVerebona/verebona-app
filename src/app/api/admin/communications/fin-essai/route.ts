/**
 * GET /api/admin/communications/fin-essai — lot 100G : séquence d'e-mails de
 * fin d'essai, SYNTHÈSE (état OK / À surveiller / Incident, jalons, réglages,
 * coupures, verrou J+80). Lecture seule, administrateurs.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { getTrialLifecycleSummary } from '@/services/trial-lifecycle/supervision.service';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  try {
    const days = Number(request.nextUrl.searchParams.get('jours') ?? 30);
    const summary = await getTrialLifecycleSummary(new Date(), [7, 30, 90].includes(days) ? days : 30);
    return NextResponse.json(summary, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[admin/communications/fin-essai] GET :', error);
    return NextResponse.json({ code: 'TRIAL_LIFECYCLE_LOAD_FAILED', message: 'Impossible de charger la séquence de fin d’essai.' }, { status: 500 });
  }
}
