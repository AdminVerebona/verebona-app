import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { computeIndicators } from '@/services/funnel-analytics.service';

/**
 * GET /api/admin/analytics/funnel?days=30
 *
 * Indicateurs du parcours de souscription (CDC tarification §17) :
 * taux d'activation, d'ajout du premier document, d'usage des fonctions
 * Premium, de conversion — globale, par offre et par periodicite —, delai
 * moyen avant souscription et taux d'expiration sans conversion.
 *
 * Le parametre `days` limite le calcul a une periode glissante ; sans lui,
 * l'ensemble de l'historique est pris en compte.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);

    const daysParam = request.nextUrl.searchParams.get('days');
    const days = daysParam ? Number(daysParam) : null;
    const since =
      days && Number.isFinite(days) && days > 0
        ? new Date(Date.now() - days * 24 * 60 * 60 * 1000)
        : undefined;

    const indicators = await computeIndicators(since);

    return NextResponse.json({
      period: since ? { since: since.toISOString(), days } : { since: null, days: null },
      indicators,
      computedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[admin/analytics/funnel] erreur:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
