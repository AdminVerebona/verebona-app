/**
 * POST /api/admin/ai/accounts/[accountId]/unlock-security
 * Débloque tous les locks sécurité IA d'un compte (admin uniquement) — action auditée
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { aiSecurityLock, aiAdminAuditLog, users } from '@/db/schema';
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
    const { reason, lockId } = body;

    // Débloque un lock spécifique ou tous les locks actifs du compte
    const filter = lockId
      ? and(eq(aiSecurityLock.id, lockId), eq(aiSecurityLock.accountId, accountId), eq(aiSecurityLock.isResolved, false))
      : and(eq(aiSecurityLock.accountId, accountId), eq(aiSecurityLock.isResolved, false));

    const activeLocks = await db
      .select({ id: aiSecurityLock.id, lockType: aiSecurityLock.lockType })
      .from(aiSecurityLock)
      .where(filter);

    if (activeLocks.length === 0) {
      return NextResponse.json({ success: true, unlockedCount: 0 });
    }

    await db.update(aiSecurityLock)
      .set({
        isResolved: true,
        resolvedAt: new Date(),
        resolvedBy: session.userId,
        resolutionNotes: reason ?? 'Débloqué manuellement par admin',
      })
      .where(filter);

    // Audit
    const adminUser = await db.select({ email: users.email }).from(users).where(eq(users.id, session.userId)).limit(1).then(r => r[0]);
    await db.insert(aiAdminAuditLog).values({
      adminUserId: session.userId,
      adminEmail: adminUser?.email ?? session.email,
      actionType: 'unlock_security',
      targetAccountId: accountId,
      targetLockId: lockId ?? null,
      beforeValue: { locks: activeLocks.map(l => l.lockType) },
      afterValue: { resolved: true, count: activeLocks.length },
      reason: reason ?? null,
      createdAt: new Date(),
    });

    return NextResponse.json({ success: true, unlockedCount: activeLocks.length });
  } catch (error: any) {
    console.error('[POST /api/admin/ai/accounts/[accountId]/unlock-security]', error);
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}
