/**
 * GET /api/admin/subscriptions?sort=plan|status|period|payment|renewal|end&dir=asc|desc&page=N
 * — CDC Back-Office V1 §7.1 et §7.2.
 *
 * Synthèse en tête (actifs, essais en cours, fins programmées, paiements
 * échoués — SUB-001, sans MRR SUB-002) et liste triable (SUB-007), paginée
 * (SUB-008), sans recherche transverse (SUB-006). Lecture seule : aucune
 * mutation d'abonnement depuis cet onglet (§7.4, SUB-014).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { getSubscriptionsOverview, parseSubscriptionSort } from '@/services/admin/subscriptions.service';

const PAGE_SIZE = 25;

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }

  const url = new URL(request.url);
  const sort = parseSubscriptionSort(url.searchParams.get('sort'));
  const direction = url.searchParams.get('dir') === 'desc' ? 'desc' : 'asc';
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);

  try {
    const { summary, list } = await getSubscriptionsOverview({ sort, direction, page, pageSize: PAGE_SIZE });
    return NextResponse.json({ summary, ...list, sort, dir: direction });
  } catch (error) {
    console.error('[admin/subscriptions] GET :', error);
    return NextResponse.json(
      { code: 'SUBSCRIPTIONS_LOAD_FAILED', message: 'Impossible de charger les abonnements.' },
      { status: 500 },
    );
  }
}
