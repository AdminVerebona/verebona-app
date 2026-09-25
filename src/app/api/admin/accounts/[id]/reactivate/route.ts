/**
 * POST /api/admin/accounts/[id]/reactivate — CDC Back-Office V1 ACC-A01,
 * ACC-A03, ACC-A05, AUD-003.
 *
 * Réactive le compte : la connexion redevient possible avec les identifiants
 * existants, sans réinitialisation de mot de passe. Aucune notification.
 * Journalisé (succès comme échec).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { reactivateAccount } from '@/services/admin/account-status.service';

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
    const outcome = await reactivateAccount(accountId);
    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.code, message: 'Compte introuvable.' }, { status: 404 });
    }
    await logAdminAction({
      adminId,
      action: 'ACCOUNT_REACTIVATE',
      targetType: 'ACCOUNT',
      targetId: accountId,
      result: 'SUCCESS',
      before: { isActive: outcome.wasActive },
      after: { isActive: true },
    });
    return NextResponse.json({ success: true, isActive: true });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    console.error('[admin/accounts/reactivate] échec :', error);
    await logAdminAction({
      adminId,
      action: 'ACCOUNT_REACTIVATE',
      targetType: 'ACCOUNT',
      targetId: accountId,
      result: 'FAILURE',
      after: { isActive: true },
      details: { error: (error as Error).message },
    });
    return NextResponse.json(
      { error: 'REACTIVATE_FAILED', message: 'La réactivation a échoué. Rechargez la fiche avant de réessayer.' },
      { status: 500 },
    );
  }
}
