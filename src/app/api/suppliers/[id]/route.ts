import { NextRequest, NextResponse } from 'next/server';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { db } from '@/db';
import { suppliers } from '@/db/schema';
import { eq, and, ne } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { apiError } from '@/lib/api-errors';
import { normalizeName, userFieldDecisionsAfterPatch, type UserFieldDecisions } from '@/services/suppliers/supplier-service';
import { getSupplierDetail } from '@/services/suppliers/supplier-detail.service';
import { validateSupplierPatch } from '@/services/suppliers/supplier-validation';

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

    const [existing] = await db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.id, supplierId), eq(suppliers.accountId, accountId), ne(suppliers.status, 'deleted')))
      .limit(1);

    if (!existing) return apiError(404, 'NOT_FOUND', 'Supplier not found');

    const body = await request.json().catch(() => null);
    const v = validateSupplierPatch(body);
    if (!v.ok) return apiError(400, 'INVALID_INPUT', v.message, { field: v.field });

    const updates: Record<string, unknown> = { ...v.updates, updatedAt: new Date() };
    if (typeof v.updates.name === 'string') updates.normalizedName = normalizeName(v.updates.name);
    // Lot 111X : protection PAR CHAMP — une saisie ou un effacement volontaire n'est jamais remplacé ni
    // réintroduit par un document (seul un champ dont la valeur CHANGE est une décision).
    updates.userFieldDecisions = userFieldDecisionsAfterPatch(
      existing as unknown as Record<string, unknown>, v.updates, existing.userFieldDecisions as UserFieldDecisions, session.userId ?? null);

    await db.update(suppliers)
      .set(updates as Partial<typeof suppliers.$inferInsert>)
      .where(and(eq(suppliers.id, supplierId), eq(suppliers.accountId, accountId)));

    // CDC Assistant §31.7 : modification d'un fournisseur.
    await emitBusinessEvent({ type: 'SUPPLIER_CHANGED', accountId, entityId: supplierId });
    // Fiche relue (IBAN masqué) : la réponse n'expose jamais la valeur bancaire.
    return NextResponse.json({ supplier: (await getSupplierDetail(accountId, supplierId))?.supplier ?? null });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
