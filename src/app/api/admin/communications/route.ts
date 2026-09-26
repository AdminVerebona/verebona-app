/**
 * GET /api/admin/communications — CDC Back-Office V1 §10.1.
 *
 * Modèles groupés par événement métier, canaux disponibles, statut par canal,
 * dernier envoi réel et nombre d'envois (COM-001 à COM-005). Lecture seule.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { getCommunicationsOverview } from '@/services/admin/communications.service';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }

  try {
    const groups = await getCommunicationsOverview();
    return NextResponse.json({ groups });
  } catch (error) {
    console.error('[admin/communications] GET :', error);
    return NextResponse.json(
      { code: 'COMMUNICATIONS_LOAD_FAILED', message: 'Impossible de charger les modèles de communication.' },
      { status: 500 },
    );
  }
}
