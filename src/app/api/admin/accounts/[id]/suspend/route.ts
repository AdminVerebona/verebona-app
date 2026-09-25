/**
 * POST /api/admin/accounts/[id]/suspend — CDC Back-Office V1 ACC-A01, ACC-A02,
 * ACC-A04, ACC-A05, AUD-003.
 *
 * Suspend le compte, révoque immédiatement les sessions de tous ses
 * utilisateurs et bloque les nouvelles connexions. Aucun motif requis, aucune
 * notification. Journalisé (succès comme échec).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { suspendAccount } from '@/services/admin/account-status.service';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }

  const { id } = await params;
  const accountId = Number(id);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    return NextResponse.json({ error: 'INVALID_ACCOUNT_ID', message: 'Identifiant de compte invalide.' }, { status: 400 });
  }

  try {
    const outcome = await suspendAccount(accountId);
    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.code, message: 'Compte introuvable.' }, { status: 404 });
    }
    await logAdminAction({
      adminId,
      action: 'ACCOUNT_SUSPEND',
      targetType: 'ACCOUNT',
      targetId: accountId,
      result: 'SUCCESS',
      before: { isActive: outcome.wasActive },
      after: { isActive: false },
      details: { revokedUserIds: outcome.revokedUserIds },
    });
    return NextResponse.json({ success: true, isActive: false, revokedSessionsFor: outcome.revokedUserIds.length });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    console.error('[admin/accounts/suspend] échec :', error);
    await logAdminAction({
      adminId,
      action: 'ACCOUNT_SUSPEND',
      targetType: 'ACCOUNT',
      targetId: accountId,
      result: 'FAILURE',
      after: { isActive: false },
      details: { error: (error as Error).message },
    });
    return NextResponse.json(
      { error: 'SUSPEND_FAILED', message: 'La suspension a échoué. Rechargez la fiche avant de réessayer.' },
      { status: 500 },
    );
  }
}
