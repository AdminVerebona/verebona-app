import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { apiError } from '@/lib/api-errors';
import { setSupplierArchived } from '@/services/suppliers/supplier-write.facade';

// POST /api/suppliers/[id]/archive — logical archive
// Lot 109B : archivage depuis la fiche (confirmation côté écran). Les relations
// historiques (documents, biens, équipements, Agenda) sont CONSERVÉES ; la
// fiche reste consultable et affiche « Archivé ». `{ "restore": true }`
// réactive la fiche. Écriture bornée au compte dans son SQL.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');
    // Lot 85D : écriture refusée en lecture seule (essai échu, impayé, résilié, rétractation).
    const refus = await refuserSiLectureSeule(accountId);
    if (refus) return refus;

    const { id } = await params;
    const supplierId = parseInt(id);
    if (isNaN(supplierId)) return apiError(400, 'INVALID_INPUT', 'Invalid supplier id');

    // Lot 114 (#753, W20) : archivage par la façade métier — la même que l'Assistant Verebona.
    const body = await request.json().catch(() => ({})) as { restore?: unknown };
    const r = await setSupplierArchived({ accountId, supplierId, restore: body?.restore === true });
    if (!r.ok) return apiError(404, 'NOT_FOUND', 'Supplier not found');
    const status = r.status;
    return NextResponse.json({ success: true, status });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
