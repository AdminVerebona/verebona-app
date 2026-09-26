/**
 * GET /api/admin/referrals/[linkId] — CDC Back-Office V1 REF-005 à REF-008.
 *
 * Détail d'un compte parrain : ses filleuls (lien vers leur fiche Compte,
 * REF-006), date d'utilisation, statut, date prévisionnelle (REF-007) et
 * réelle d'attribution, avantage, annulation éventuelle. Lecture seule
 * (REF-009).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { getReferrerDetail } from '@/services/admin/referrals.service';

export async function GET(request: NextRequest, { params }: { params: Promise<{ linkId: string }> }) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }

  const linkId = Number((await params).linkId);
  if (!Number.isSafeInteger(linkId) || linkId <= 0) {
    return NextResponse.json({ code: 'INVALID_ID', message: 'Identifiant invalide.' }, { status: 400 });
  }
  try {
    const detail = await getReferrerDetail(linkId);
    if (!detail) return NextResponse.json({ code: 'NOT_FOUND', message: 'Code de parrainage introuvable.' }, { status: 404 });
    return NextResponse.json(detail);
  } catch (error) {
    console.error('[admin/referrals/[linkId]] GET :', error);
    return NextResponse.json({ code: 'REFERRAL_LOAD_FAILED', message: 'Impossible de charger le parrainage.' }, { status: 500 });
  }
}
