import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { apiError } from '@/lib/api-errors';
import { getSupplierDetail } from '@/services/suppliers/supplier-detail.service';
import { updateSupplierForAccount } from '@/services/suppliers/supplier-write.facade';

// Lot 49 (SEC-06) : fournisseur du compte actif ; objets liés re-filtrés sur
// le compte (une relation incorrecte en base n'expose rien d'un autre compte) ;
// mise à jour bornée au compte dans son SQL.
//
// Lot 109B : la fiche `/fournisseurs/[id]` est l'UNIQUE interface (le tiroir
// fournisseur est supprimé). GET rend la même lecture que `/overview`
// (sections paginées avec total exact, conflits avec preuve, IBAN masqué) —
// plus de liste de documents plafonnée à 50, plus d'IBAN en clair, plus de
// statut global de vérification.

// GET /api/suppliers/[id] — fiche (identique à /overview)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

    const { id } = await params;
    if (!/^\d{1,10}$/.test(id)) return apiError(400, 'INVALID_INPUT', 'Invalid supplier id');

    const detail = await getSupplierDetail(accountId, Number(id));
    if (!detail) return apiError(404, 'NOT_FOUND', 'Supplier not found');
    return NextResponse.json(detail);
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}

// PATCH /api/suppliers/[id] — update
export async function PATCH(
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
    if (!/^\d{1,10}$/.test(id)) return apiError(400, 'INVALID_INPUT', 'Invalid supplier id');
    const supplierId = Number(id);

    // Lot 114 (#753, W19) : modification par la façade métier — la même que l'Assistant Verebona (validation,
    // protection par champ SET / CLEARED du lot 111X, événement SUPPLIER_CHANGED).
    const body = await request.json().catch(() => null);
    const r = await updateSupplierForAccount({ accountId, userId: session.userId ?? null, supplierId, body });
    if (!r.ok && r.code === 'NOT_FOUND') return apiError(404, 'NOT_FOUND', 'Supplier not found');
    if (!r.ok) return apiError(400, 'INVALID_INPUT', r.message, { field: r.field });

    // Fiche relue (IBAN masqué) : la réponse n'expose jamais la valeur bancaire.
    return NextResponse.json({ supplier: (await getSupplierDetail(accountId, supplierId))?.supplier ?? null });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
