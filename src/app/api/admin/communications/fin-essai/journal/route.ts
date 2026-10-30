/**
 * GET /api/admin/communications/fin-essai/journal — lot 100G : DÉTAIL du
 * journal de la séquence de fin d'essai (envois, échecs, non-envois motivés,
 * blocages, conversions, désinscriptions, réglages). Filtres : `jalon`,
 * `type`, `motif`, `compte`, `page`. Aucune adresse e-mail d'utilisateur.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { listTrialLifecycleJournal } from '@/services/trial-lifecycle/supervision.service';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const sp = request.nextUrl.searchParams;
  const num = (k: string) => {
    const n = Number(sp.get(k));
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  try {
    const r = await listTrialLifecycleJournal({
      milestone: sp.get('jalon'), eventType: sp.get('type'), reason: sp.get('motif'),
      accountId: num('compte'), page: num('page') ?? 1, pageSize: num('taille') ?? 50,
    });
    return NextResponse.json(r, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[admin/communications/fin-essai/journal] GET :', error);
    return NextResponse.json({ code: 'TRIAL_LIFECYCLE_JOURNAL_FAILED', message: 'Impossible de charger le journal.' }, { status: 500 });
  }
}
