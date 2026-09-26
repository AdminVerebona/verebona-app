/**
 * GET /api/admin/referentials — CDC Back-Office V1 §9.
 *
 * Photographie courante des référentiels et de leurs utilisations
 * (REFD-003, REFD-005). Lecture seule : aucune méthode d'écriture n'est
 * exposée (REFD-006).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { loadReferentials } from './referentials-data';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }

  try {
    return NextResponse.json(await loadReferentials());
  } catch (error) {
    console.error('[admin/referentials] GET :', error);
    return NextResponse.json(
      { code: 'REFERENTIALS_LOAD_FAILED', message: 'Impossible de charger les référentiels.' },
      { status: 500 },
    );
  }
}
