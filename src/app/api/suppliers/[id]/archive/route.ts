import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { suppliers } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';

// POST /api/suppliers/[id]/archive — logical archive
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

    const { id } = await params;
    const supplierId = parseInt(id);
    if (isNaN(supplierId)) return apiError(400, 'INVALID_INPUT', 'Invalid supplier id');

    const [existing] = await db
      .select({ id: suppliers.id, status: suppliers.status })
      .from(suppliers)
      .where(and(eq(suppliers.id, supplierId), eq(suppliers.accountId, accountId)))
      .limit(1);

    if (!existing) return apiError(404, 'NOT_FOUND', 'Supplier not found');

    await db.update(suppliers)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(eq(suppliers.id, supplierId));

    return NextResponse.json({ success: true });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
