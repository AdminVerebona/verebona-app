/**
 * GET /api/admin/communications/preview-context — CDC Back-Office V1 COM-008.
 *
 * Biens, documents, échéances, abonnement, paiements (factures) et
 * rétractations du PROPRE compte de
 * l'administrateur connecté, sélectionnables comme contexte de
 * prévisualisation (COM-007, SEC-005). Lecture seule.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getSession, sessionErrorResponse } from '@/lib/auth-guards';
import { loadPreviewContextOptions } from '@/services/admin/communications.service';

export async function GET(request: NextRequest) {
  let adminId: number;
  let currentAccountId: number | undefined;
  try {
    adminId = await requireAdmin(request);
    currentAccountId = (await getSession(request)).currentAccountId;
  } catch (error) {
    return sessionErrorResponse(error);
  }
  try {
    const options = await loadPreviewContextOptions(adminId, currentAccountId);
    return NextResponse.json({ ...options, hasAccount: options.accountId !== null, accountId: undefined });
  } catch (error) {
    console.error('[admin/communications/preview-context] GET :', error);
    return NextResponse.json({ code: 'LOAD_FAILED', message: 'Chargement du contexte impossible.' }, { status: 500 });
  }
}
