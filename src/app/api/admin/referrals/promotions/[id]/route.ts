/**
 * GET /api/admin/referrals/promotions/[id] — CDC Back-Office V1 PRO-002.
 *
 * Comptes concernés par un code promotionnel, avec leur conversion payante.
 * Lecture seule.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { getPromotionAccounts } from '@/services/admin/referrals.service';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }

  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ code: 'INVALID_ID', message: 'Identifiant invalide.' }, { status: 400 });
  }
  try {
    const detail = await getPromotionAccounts(id);
    if (!detail) return NextResponse.json({ code: 'NOT_FOUND', message: 'Code promotionnel introuvable.' }, { status: 404 });
    return NextResponse.json(detail);
  } catch (error) {
    console.error('[admin/referrals/promotions/[id]] GET :', error);
    return NextResponse.json({ code: 'PROMOTION_LOAD_FAILED', message: 'Impossible de charger le code promotionnel.' }, { status: 500 });
  }
}
