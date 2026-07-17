import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { equipmentSuppliers, suppliers, accounts } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';

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
      .innerJoin(suppliers, eq(suppliers.id, equipmentSuppliers.supplierId))
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

    const body = await request.json();
    const { supplierId, relationshipType, isPrimary } = body;
    if (!supplierId) return apiError(400, 'INVALID_INPUT', 'supplierId is required');

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

    await db.insert(equipmentSuppliers).values({
      equipmentId,
      supplierId,
      relationshipType: relationshipType ?? null,
      sourceType: 'manual',
      isPrimary: isPrimary ?? false,
    });

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
