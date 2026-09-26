/**
 * GET /api/admin/referrals?sort=uses|conversions&dir=asc|desc&page=N
 * — CDC Back-Office V1 §8.1, §8.2.
 *
 * Synthèse séparée parrainage / promotions Stripe (aucun total mélangé), et
 * liste des codes de parrainage — un par compte (REF-004) — triable par
 * utilisations et conversions payantes (REF-002), paginée (REF-003).
 * Pas de CA ni de taux de conversion par code (REF-001). Lecture seule
 * (REF-009).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { getReferralPromotionSummary, listReferrers, parseCodeSort } from '@/services/admin/referrals.service';

const PAGE_SIZE = 25;

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }

  const url = new URL(request.url);
  const sort = parseCodeSort(url.searchParams.get('sort'));
  const dir = url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);

  try {
    const [summary, referrers] = await Promise.all([
      getReferralPromotionSummary(),
      listReferrers(sort, dir, page, PAGE_SIZE),
    ]);
    return NextResponse.json({ summary, referrers, sort, dir });
  } catch (error) {
    console.error('[admin/referrals] GET :', error);
    return NextResponse.json(
      { code: 'REFERRALS_LOAD_FAILED', message: 'Impossible de charger les parrainages.' },
      { status: 500 },
    );
  }
}
