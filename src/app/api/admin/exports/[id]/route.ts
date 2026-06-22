import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { exportGenerations } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin(request);

    const { id } = await params;
    const exportId = parseInt(id);
    if (isNaN(exportId)) {
      return NextResponse.json({ error: 'ID invalide' }, { status: 400 });
    }

    const existing = await db
      .select({ id: exportGenerations.id })
      .from(exportGenerations)
      .where(eq(exportGenerations.id, exportId))
      .limit(1);

    if (existing.length === 0) {
      return NextResponse.json({ error: 'Export introuvable' }, { status: 404 });
    }

    await db
      .update(exportGenerations)
      .set({ status: 'deleted' })
      .where(eq(exportGenerations.id, exportId));

    return NextResponse.json({ success: true });

  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (['INVALID_TOKEN', 'AUTH_REQUIRED', 'INSUFFICIENT_PERMISSIONS', 'ACCOUNT_SUSPENDED'].includes(message)) {
      const { SessionService } = await import('@/lib/session-service');
      return SessionService.handleSessionError(error);
    }
    console.error('DELETE admin export error:', message);
    return NextResponse.json({ error: message, code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
