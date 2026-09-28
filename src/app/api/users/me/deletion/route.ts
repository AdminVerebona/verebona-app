/**
 * Suppression volontaire du compte, différée de 30 jours (AID-ACCOUNT-006).
 *
 * GET    — état : aucune suppression, ou date prévue et jours restants.
 * POST   — clôture le compte et programme la suppression (texte de
 *          confirmation + mot de passe). Voir `close-account.ts`.
 * DELETE — annule la suppression : accès normal rétabli. L'abonnement résilié
 *          n'est PAS réactivé d'office et les partages ne sont pas rétablis.
 *
 * GET et DELETE restent accessibles à un compte clôturé
 * (`lib/auth/account-closure`) ; POST, non (déjà clôturé).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import {
  cancelAccountDeletion,
  getAccountDeletionStatus,
} from '@/services/account/voluntary-deletion.service';
import { handleCloseAccount, reopenSessionOnThisDevice } from './close-account';

export async function GET(request: NextRequest) {
  let userId: number;
  try {
    userId = (await SessionService.getSession(request)).userId;
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
  try {
    return NextResponse.json(
      { deletion: await getAccountDeletionStatus(userId) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[account-deletion] lecture :', error);
    return NextResponse.json(
      { error: 'ACCOUNT_DELETION_READ_FAILED', message: 'Impossible de lire l’état de la suppression. Réessayez.' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  return handleCloseAccount(request);
}

export async function DELETE(request: NextRequest) {
  let userId: number;
  try {
    userId = (await SessionService.getSession(request)).userId;
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
  try {
    const result = await cancelAccountDeletion({ userId });
    if (!result.ok) {
      const message = result.code === 'IN_PROGRESS'
        ? 'La suppression de votre compte est en cours d’exécution : elle ne peut plus être annulée.'
        : 'Aucune suppression de compte n’est en cours.';
      return NextResponse.json({ error: result.code, message }, { status: result.code === 'USER_NOT_FOUND' ? 404 : 409 });
    }
    const response = NextResponse.json({
      success: true,
      message: 'La suppression de votre compte est annulée. Vous retrouvez un accès normal.',
      redirectTo: '/accueil',
    });
    await reopenSessionOnThisDevice(request, response, userId);
    return response;
  } catch (error) {
    console.error('[account-deletion] annulation :', error);
    return NextResponse.json(
      { error: 'ACCOUNT_DELETION_CANCEL_FAILED', message: 'L’annulation n’a pas pu être enregistrée. Réessayez.' },
      { status: 500 },
    );
  }
}
