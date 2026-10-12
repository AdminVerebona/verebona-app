import { NextRequest, NextResponse } from 'next/server';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { db } from '@/db';
import { equipmentSuppliers, suppliers, accounts } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { equipmentInAccount, ownedSql } from '@/services/security/account-ownership';

// Lot 49 (SEC-03) : l'équipement (par son bien) ET le fournisseur doivent
// appartenir au compte actif, vérifiés AVANT toute lecture ou insertion ;
// l'insertion porte en plus la condition de compte dans son SQL. Un
// équipement d'un autre compte rend 404 (rien n'est révélé) ; une relation
// incorrecte en base n'expose jamais la fiche d'un autre compte.

async function getAccountPlanType(accountId: number): Promise<string> {
  const [account] = await db
    .select({ planType: accounts.planType })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return account?.planType ?? 'STANDARD';
}

// GET /api/equipments/[id]/suppliers — paid accounts only
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

    const planType = await getAccountPlanType(accountId);
    if (planType === 'STANDARD') {
      return NextResponse.json({ suppliers: [] });
    }

    const { id } = await params;
    const equipmentId = parseInt(id);
    if (isNaN(equipmentId)) return apiError(400, 'INVALID_INPUT', 'Invalid equipment id');
    if (!(await equipmentInAccount(accountId, equipmentId))) return apiError(404, 'NOT_FOUND', 'Equipment not found');

    const rows = await db
      .select({
        supplierId: suppliers.id,
        supplierPublicId: suppliers.publicId,
        name: suppliers.name,
        email: suppliers.email,
        phone: suppliers.phone,
        contactStatus: suppliers.contactStatus,
        isPrimary: equipmentSuppliers.isPrimary,
        relationshipType: equipmentSuppliers.relationshipType,
        sourceType: equipmentSuppliers.sourceType,
        // iban excluded
      })
      .from(equipmentSuppliers)
      .innerJoin(suppliers, and(eq(suppliers.id, equipmentSuppliers.supplierId), eq(suppliers.accountId, accountId)))
      .where(eq(equipmentSuppliers.equipmentId, equipmentId));

    return NextResponse.json({ suppliers: rows });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}

// POST /api/equipments/[id]/suppliers — paid accounts only
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

    const planType = await getAccountPlanType(accountId);
    if (planType === 'STANDARD') {
      return apiError(403, 'FORBIDDEN', 'Cette fonctionnalité nécessite un abonnement payant');
    }

    const { id } = await params;
    const equipmentId = parseInt(id);
    if (isNaN(equipmentId)) return apiError(400, 'INVALID_INPUT', 'Invalid equipment id');
    if (!(await equipmentInAccount(accountId, equipmentId))) return apiError(404, 'NOT_FOUND', 'Equipment not found');

    const body = await request.json();
    const { relationshipType, isPrimary } = body;
    const supplierId = Number(body.supplierId);
    if (!Number.isInteger(supplierId) || supplierId <= 0) return apiError(400, 'INVALID_INPUT', 'supplierId is required');

    const [supplier] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.id, supplierId), eq(suppliers.accountId, accountId)))
      .limit(1);

    if (!supplier) return apiError(404, 'NOT_FOUND', 'Supplier not found');

    const existing = await db
      .select()
      .from(equipmentSuppliers)
      .where(and(
        eq(equipmentSuppliers.equipmentId, equipmentId),
        eq(equipmentSuppliers.supplierId, supplierId),
      ))
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json({ success: true, alreadyLinked: true });
    }

    // Insertion bornée au compte (équipement ET fournisseur) dans son SQL.
    const inserted = (await db.execute(sql`
      INSERT INTO equipment_suppliers (equipment_id, supplier_id, relationship_type, source_type, is_primary)
      SELECT ${equipmentId}, ${supplierId}, ${relationshipType ?? null}, 'manual', ${isPrimary === true}
       WHERE ${ownedSql('equipment', equipmentId, accountId)} AND ${ownedSql('supplier', supplierId, accountId)}
      ON CONFLICT DO NOTHING
      RETURNING equipment_id`)) as unknown as unknown[];
    if (inserted.length === 0) return NextResponse.json({ success: true, alreadyLinked: true });

    // CDC Assistant §31.7 : fournisseur rattaché à un équipement.
    await emitBusinessEvent({ type: 'SUPPLIER_CHANGED', accountId, entityId: null });
    return NextResponse.json({ success: true }, { status: 201 });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
