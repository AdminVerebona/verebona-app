/**
 * PATCH /api/admin/ai/accounts/[accountId]/quota
 * Modifie le quota IA d'un compte (admin uniquement) — action auditée
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { aiUsageAccountCounter, aiAdminAuditLog, users } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { requireAdmin } from '@/lib/auth-guards';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    // Garde serveur commune à /api/admin (CDC BO GEN-002, BO IA GEN-013) :
    // `requireAdmin` relit le rôle en base si le jeton est antérieur à une
    // promotion, ce que la comparaison manuelle du rôle ne faisait pas.
    let adminUserId: number;
    try {
      adminUserId = await requireAdmin(request);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    const session = await SessionService.getSession(request);

    const { accountId: accountIdStr } = await params;
    const accountId = parseInt(accountIdStr);
    if (isNaN(accountId)) return NextResponse.json({ error: 'ID invalide' }, { status: 400 });

    const body = await request.json();
    const { documentsAnalyzedQuota, trialDocumentsQuota, reason } = body;

    const currentYear = new Date().getFullYear();

    // Récupère le compteur existant
    const existing = await db
      .select()
      .from(aiUsageAccountCounter)
      .where(and(eq(aiUsageAccountCounter.accountId, accountId), eq(aiUsageAccountCounter.periodYear, currentYear)))
      .limit(1)
      .then(r => r[0]);

    const beforeValue = existing
      ? { documentsAnalyzedQuota: existing.documentsAnalyzedQuota, trialDocumentsQuota: existing.trialDocumentsQuota }
      : null;

    if (existing) {
      await db.update(aiUsageAccountCounter)
        .set({
          ...(documentsAnalyzedQuota !== undefined ? { documentsAnalyzedQuota } : {}),
          ...(trialDocumentsQuota !== undefined ? { trialDocumentsQuota } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(aiUsageAccountCounter.accountId, accountId), eq(aiUsageAccountCounter.periodYear, currentYear)));
    } else {
      await db.insert(aiUsageAccountCounter).values({
        accountId,
        periodYear: currentYear,
        documentsAnalyzedQuota: documentsAnalyzedQuota ?? 0,
        trialDocumentsQuota: trialDocumentsQuota ?? 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    // Audit
    const adminUser = await db.select({ email: users.email }).from(users).where(eq(users.id, adminUserId)).limit(1).then(r => r[0]);
    await db.insert(aiAdminAuditLog).values({
      adminUserId: adminUserId,
      adminEmail: adminUser?.email ?? session.email,
      actionType: 'modify_quota',
      targetAccountId: accountId,
      beforeValue: beforeValue ?? {},
      afterValue: { documentsAnalyzedQuota, trialDocumentsQuota },
      reason: reason ?? null,
      createdAt: new Date(),
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('[PATCH /api/admin/ai/accounts/[accountId]/quota]', error);
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}
