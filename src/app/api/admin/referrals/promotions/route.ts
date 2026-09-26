/**
 * GET /api/admin/referrals/promotions?sort=uses|conversions&dir=asc|desc&page=N
 * — CDC Back-Office V1 §8.3.
 *
 * Codes promotionnels Stripe : utilisations, conversions payantes et lien
 * « Ouvrir dans Stripe » (PRO-002). Les codes sont créés et configurés dans
 * Stripe (PRO-001) ; leurs paramètres détaillés n'y sont pas dupliqués
 * (PRO-003). Lecture seule.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { listPromotions, parseCodeSort } from '@/services/admin/referrals.service';

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
    return NextResponse.json({ ...(await listPromotions(sort, dir, page, PAGE_SIZE)), sort, dir });
  } catch (error) {
    console.error('[admin/referrals/promotions] GET :', error);
    return NextResponse.json({ code: 'PROMOTIONS_LOAD_FAILED', message: 'Impossible de charger les promotions.' }, { status: 500 });
  }
}
