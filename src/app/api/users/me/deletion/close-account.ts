/**
 * Clôture du compte (suppression volontaire différée de 30 jours) — partagé
 * par POST /api/users/me/deletion et DELETE /api/users/me (ancien point
 * d'entrée de la suppression immédiate, conservé pour les clients existants).
 *
 * Confirmation renforcée : texte « SUPPRIMER MON COMPTE » ET preuve
 * d'identité — preuve de réauthentification fraîche de la session (lot 92,
 * consommée) ou mot de passe dans la requête (historique). Toutes les sessions
 * sont révoquées ; CET appareil reçoit une session neuve, au statut
 * PENDING_DELETION, qui ne donne accès qu'à l'écran « Compte en cours de
 * suppression » (annuler, exporter).
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, getUserSessionCutoff, hashToken, revokeToken } from '@/db';
import { users } from '@/db/schema';
import { SessionService } from '@/lib/session-service';
import { sessionSubjectFor } from '@/lib/auth/session-tokens';
import { issueSession } from '@/lib/auth/session-issuance';
import {
  ACCOUNT_DELETION_CONFIRMATION,
  CLOSURE_ERROR_STATUS,
  closeAccountForDeletion,
  toStatusView,
} from '@/services/account/voluntary-deletion.service';
import { PENDING_DELETION_PAGE } from '@/lib/auth/account-closure';
import { reauthBlockedResponse, recordReauthFailure, recordReauthSuccess } from '@/lib/auth/reauth-throttle';
import { consumeReauthProof, getReauthState, reauthRequiredResponse } from '@/lib/auth/reauth';
import { REFRESH_TOKEN_TTL_S } from '@/lib/auth/token-lifetimes';
import { revokeAppleAuthorizationsForUser } from '@/lib/auth/oauth/account-security';

const REFRESH_TTL_MS = REFRESH_TOKEN_TTL_S * 1000;

/**
 * Rouvre une session sur cet appareil, émise strictement APRÈS la borne de
 * révocation (sinon elle serait refusée comme les autres), et révoque le
 * jeton de renouvellement présenté.
 */
export async function reopenSessionOnThisDevice(request: NextRequest, response: NextResponse, userId: number): Promise<void> {
  const cutoff = await getUserSessionCutoff(userId);
  if (cutoff) while (Date.now() <= cutoff.getTime()) await new Promise((r) => setTimeout(r, 1));
  const [user] = await db
    .select({ id: users.id, email: users.email, role: users.role, planType: users.planType, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  // Lot 92 : nouvelle session (émise après la borne) qui REMPLACE celle de cet
  // appareil dans le registre — émission unique.
  if (user) await issueSession(request, response, { kind: 'open', method: 'session_reopen', replaceCurrent: true, subject: await sessionSubjectFor(user) });
  const presented = request.cookies.get('refresh_token')?.value;
  if (presented) {
    await revokeToken(await hashToken(presented), userId, new Date(Date.now() + REFRESH_TTL_MS))
      .catch((e) => console.error('[account-deletion] révocation du jeton présenté :', e));
  }
}

export async function handleCloseAccount(request: NextRequest): Promise<NextResponse> {
  let userId: number;
  let sid: string | undefined;
  try {
    const session = await SessionService.getSession(request);
    userId = session.userId;
    sid = session.sid;
  } catch (error) {
    return SessionService.handleSessionError(error);
  }

  // Vérification de mot de passe : limiteur PARTAGÉ de la réauthentification
  // (lot 53A, CDC 18 §33 / SEC-04 — était un `Map` en mémoire par instance),
  // par utilisateur ET par IP ; seuls les mots de passe faux comptent. Une
  // session volée ne doit pas servir à deviner le mot de passe. Désactivé en
  // développement, comme la connexion.
  const blocked = await reauthBlockedResponse(request, userId);
  if (blocked) return blocked;

  const body = (await request.json().catch(() => ({}))) as { confirmation?: unknown; password?: unknown };
  const password = typeof body.password === 'string' && body.password ? body.password : null;
  const confirmation = typeof body.confirmation === 'string' ? body.confirmation : null;
  const now = new Date();

  // Lot 92 (CDC 18 §25, REAUTH-07, Q7) : sans mot de passe dans la requête,
  // l'identité est prouvée par la preuve de réauthentification fraîche de
  // CETTE session, CONSOMMÉE au succès (action à risque maximal). Le texte
  // « SUPPRIMER MON COMPTE » reste exigé. Mot de passe fourni : parcours
  // historique inchangé (clients non mis à jour).
  const reauth = password ? null : await getReauthState(userId, sid, now);
  if (reauth && reauth.state !== 'fresh' && confirmation === ACCOUNT_DELETION_CONFIRMATION) {
    return reauthRequiredResponse(reauth.state === 'expired' ? 'REAUTH_EXPIRED' : 'REAUTH_REQUIRED');
  }
  try {
    const result = await closeAccountForDeletion({
      userId,
      confirmation,
      password,
      // Lot 92 + 93 (CDC 18 §25) : sans mot de passe saisi, la preuve de
      // réauthentification fraîche de CETTE session (mot de passe, Google ou
      // Apple — seule voie d'un compte sans mot de passe) vaut identité.
      reauthProven: reauth?.state === 'fresh',
      now,
    });
    if (!result.ok) {
      if (result.code === 'INVALID_PASSWORD') await recordReauthFailure(request, userId, 'account_deletion');
      return NextResponse.json({ error: result.code, message: result.message }, { status: CLOSURE_ERROR_STATUS[result.code] });
    }

    if (reauth?.state === 'fresh') await consumeReauthProof(reauth.proof.id, 'account_deletion', now);
    else await recordReauthSuccess(userId);
    // Lot 93 (CDC 18 §25) : Sign in with Apple — autorisation révoquée chez
    // Apple à la demande de suppression (au mieux).
    await revokeAppleAuthorizationsForUser(userId).catch((e) => console.error('[account-deletion] révocation Apple :', (e as Error)?.message ?? e));
    const response = NextResponse.json({
      success: true,
      deletion: toStatusView(result.schedule, now),
      stoppedSubscriptions: result.stoppedSubscriptions.length,
      redirectTo: PENDING_DELETION_PAGE,
    });
    await reopenSessionOnThisDevice(request, response, userId);
    return response;
  } catch (error) {
    console.error('[account-deletion] clôture :', error);
    return NextResponse.json(
      { error: 'ACCOUNT_CLOSURE_FAILED', message: 'La suppression n’a pas pu être programmée. Réessayez dans quelques instants.' },
      { status: 500 },
    );
  }
}
