/**
 * POST /api/admin/ai/accounts/[accountId]/reset-counter
 * Remet à zéro le compteur de documents analysés (admin uniquement) — action auditée
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { aiUsageAccountCounter, aiAdminAuditLog, users } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const session = await SessionService.getSession(request);
    if (session.role !== 'ADMIN' && session.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Accès refusé' }, { status: 403 });
    }

    const { accountId: accountIdStr } = await params;
    const accountId = parseInt(accountIdStr);
    if (isNaN(accountId)) return NextResponse.json({ error: 'ID invalide' }, { status: 400 });

    const body = await request.json().catch(() => ({}));
    const { reason } = body;
    const currentYear = new Date().getFullYear();

    const existing = await db
      .select()
      .from(aiUsageAccountCounter)
      .where(and(eq(aiUsageAccountCounter.accountId, accountId), eq(aiUsageAccountCounter.periodYear, currentYear)))
      .limit(1)
      .then(r => r[0]);

    const beforeValue = existing
      ? { documentsAnalyzedCount: existing.documentsAnalyzedCount, trialDocumentsCount: existing.trialDocumentsCount }
      : { documentsAnalyzedCount: 0, trialDocumentsCount: 0 };

    if (existing) {
      await db.update(aiUsageAccountCounter)
        .set({
          documentsAnalyzedCount: 0,
          trialDocumentsCount: 0,
          lastResetAt: new Date(),
          resetByAdminId: session.userId,
          updatedAt: new Date(),
        })
        .where(and(eq(aiUsageAccountCounter.accountId, accountId), eq(aiUsageAccountCounter.periodYear, currentYear)));
    }

    // Audit
    const adminUser = await db.select({ email: users.email }).from(users).where(eq(users.id, session.userId)).limit(1).then(r => r[0]);
    await db.insert(aiAdminAuditLog).values({
      adminUserId: session.userId,
      adminEmail: adminUser?.email ?? session.email,
      actionType: 'reset_counter',
      targetAccountId: accountId,
      beforeValue,
      afterValue: { documentsAnalyzedCount: 0, trialDocumentsCount: 0 },
      reason: reason ?? null,
      createdAt: new Date(),
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('[POST /api/admin/ai/accounts/[accountId]/reset-counter]', error);
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}
