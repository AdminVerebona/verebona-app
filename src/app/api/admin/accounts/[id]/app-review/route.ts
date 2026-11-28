/**
 * BO › Fiche compte › « Double authentification » et « Compte de revue des
 * stores » (cartes #876, #879).
 *
 * GET  : identités ayant un droit actif, dispense de l'obligation globale de
 *        double authentification (politique générale par défaut ; dispense
 *        enregistrée, état effectif, motif de non-effectivité — y compris
 *        obligation globale inactive), qualification facultative du compte,
 *        droits de démonstration, historique. Tout administrateur.
 *
 * POST { action, kind?, userId?, reason, confirm } — ADMINISTRATEUR (#879 :
 *        rôle ADMIN ; SUPER_ADMIN historique accepté comme par
 *        `requireAdmin`), rôle ET statut RELUS EN BASE, et, dans cet ordre :
 *          1. session de niveau 2 (authentification forte) ;
 *          2. réauthentification FORTE fraîche (clé d'accès ou application
 *             d'authentification, `getReauthState`), CONSOMMÉE : une preuve
 *             par opération ;
 *          3. phrase « CONFIRMER » et motif (10 caractères au moins).
 *        Actions : grant | revoke (dispense, SANS qualification préalable) ;
 *        qualify | unqualify | demo_rights (compte de revue, facultatif)
 *        (`services/admin/app-review.service.ts`). Rétablissement de la
 *        politique générale : sessions de l'identité révoquées aussitôt. Journal BO
 *        (avant / après) + historique `app_review_events`.
 *
 * Aucun secret n'est reçu ni renvoyé : les identifiants des comptes de revue
 * se remettent uniquement dans les champs privés des consoles des stores.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse, isSessionError } from '@/lib/auth-guards';
import { SessionService } from '@/lib/session-service';
import { consumeReauthProof, reauthRequiredResponse, requireFreshReauth } from '@/lib/auth/reauth';
import { logAdminAction } from '@/lib/admin-audit';
import { isAppReviewKind } from '@/lib/auth/mfa/app-review';
import {
  AppReviewAdminError, APP_REVIEW_ACTIONS, APP_REVIEW_CONFIRMATION, APP_REVIEW_REASON_MIN_LENGTH, canManageAppReview,
  grantDemoRights, type AppReviewAction, grantExemption, loadAppReviewView, normalizeReason,
  qualifyAccount, revokeExemption, unqualifyAccount, type AppReviewChange,
} from '@/services/admin/app-review.service';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function parseAccountId(raw: string): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ error: code, code, message }, { status, headers: NO_STORE });

/** Rôle et statut de l'administrateur, relus en base (jamais déduits du jeton). */
async function dbActor(userId: number): Promise<{ role: string | null; status: string | null }> {
  const { pgClient } = await import('@/db');
  const [r] = await pgClient<{ role: string; status: string }[]>`SELECT role, status FROM users WHERE id = ${userId}`;
  return { role: r?.role ?? null, status: r?.status ?? null };
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const accountId = parseAccountId((await context.params).id);
  if (!accountId) return fail(400, 'INVALID_ACCOUNT_ID', 'Identifiant de compte invalide.');
  try {
    const [view, session, actor] = await Promise.all([
      loadAppReviewView(accountId), SessionService.getSession(request), dbActor(adminId),
    ]);
    return NextResponse.json({
      ...view,
      viewer: {
        role: actor.role,
        canManage: canManageAppReview(actor.role, actor.status) && session.aal === 2,
        strongSession: session.aal === 2,
      },
      confirmation: APP_REVIEW_CONFIRMATION,
      reasonMinLength: APP_REVIEW_REASON_MIN_LENGTH,
    }, { headers: NO_STORE });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    if (error instanceof AppReviewAdminError) return fail(error.httpStatus, error.code, error.message);
    console.error('[admin/accounts/app-review] lecture :', (error as Error)?.message ?? error);
    return fail(500, 'APP_REVIEW_READ_FAILED', 'Lecture impossible (voir le journal du serveur).');
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const accountId = parseAccountId((await context.params).id);
  if (!accountId) return fail(400, 'INVALID_ACCOUNT_ID', 'Identifiant de compte invalide.');
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = APP_REVIEW_ACTIONS.find((a) => a === body.action) as AppReviewAction | undefined;

  const deny = (code: string, message: string, status = 403) => {
    void logAdminAction({ adminId, action: 'APP_REVIEW_UPDATE', targetType: 'ACCOUNT', targetId: accountId, result: 'DENIED', details: { action: action ?? null, code } });
    return fail(status, code, message);
  };

  // 1. Rôle ET statut relus en base : administrateur actif (jamais déduit du jeton).
  //    Erreur de lecture : refus (état inconnu = refus).
  let actor: { role: string | null; status: string | null };
  try {
    actor = await dbActor(adminId);
  } catch (error) {
    console.error('[admin/accounts/app-review] rôle :', (error as Error)?.message ?? error);
    return fail(503, 'SESSION_UNAVAILABLE', 'Vérification impossible. Réessayez.');
  }
  if (!canManageAppReview(actor.role, actor.status)) return deny('ADMIN_REQUIRED', 'Réservé à un administrateur actif.');

  // 2. Entrées (aucun secret attendu).
  if (!action) return fail(400, 'INVALID_ACTION', 'Action inconnue.');
  const reason = normalizeReason(body.reason);
  if (!reason) return fail(400, 'REASON_REQUIRED', `Indiquez un motif (${APP_REVIEW_REASON_MIN_LENGTH} caractères au moins).`);
  if (body.confirm !== APP_REVIEW_CONFIRMATION) return fail(400, 'CONFIRMATION_REQUIRED', `Saisissez ${APP_REVIEW_CONFIRMATION} pour confirmer.`);
  const kind = body.kind;
  if (action === 'qualify' && !isAppReviewKind(kind)) return fail(400, 'INVALID_KIND', 'Qualification attendue : APPLE ou GOOGLE.');
  const userId = Number(body.userId);
  if ((action === 'grant' || action === 'revoke') && !(Number.isSafeInteger(userId) && userId > 0)) {
    return fail(400, 'INVALID_USER_ID', 'Identité à autoriser ou révoquer invalide.');
  }

  // 3. Authentification forte : session de niveau 2 (vérifiée AVANT toute
  //    demande de confirmation), puis réauthentification FORTE fraîche, consommée.
  const strongDenied = () => deny('STRONG_AUTH_REQUIRED', 'Connectez-vous avec la double authentification (clé d’accès ou application d’authentification) pour cette action.');
  try {
    if ((await SessionService.getSession(request)).aal !== 2) return strongDenied();
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const check = await requireFreshReauth(request, { action: `app_review:${action}` });
  if (!check.ok) return check.response;
  if (check.session.aal !== 2) return strongDenied();
  if ((check.proof.assurance ?? 1) < 2) return reauthRequiredResponse('REAUTH_REQUIRED', { mfa: true });
  if (!(await consumeReauthProof(check.proof.id, `app_review:${action}`))) return reauthRequiredResponse('REAUTH_EXPIRED', { mfa: true });

  // 4. Opération.
  let change: AppReviewChange;
  try {
    switch (action) {
      case 'qualify': change = await qualifyAccount(accountId, kind as 'APPLE' | 'GOOGLE', adminId, reason); break;
      case 'unqualify': change = await unqualifyAccount(accountId, adminId, reason); break;
      case 'grant': change = await grantExemption(accountId, userId, adminId, reason); break;
      case 'revoke': change = await revokeExemption(accountId, userId, adminId, reason); break;
      case 'demo_rights': change = await grantDemoRights(accountId, adminId, reason); break;
    }
  } catch (error) {
    if (error instanceof AppReviewAdminError) {
      void logAdminAction({ adminId, action: 'APP_REVIEW_UPDATE', targetType: 'ACCOUNT', targetId: accountId, result: 'DENIED', details: { action, code: error.code, userId: Number.isSafeInteger(userId) ? userId : null } });
      return fail(error.httpStatus, error.code, error.message);
    }
    console.error('[admin/accounts/app-review] opération :', (error as Error)?.message ?? error);
    void logAdminAction({ adminId, action: 'APP_REVIEW_UPDATE', targetType: 'ACCOUNT', targetId: accountId, result: 'FAILURE', details: { action, error: (error as Error)?.message ?? String(error) } });
    return fail(500, 'APP_REVIEW_FAILED', 'Opération impossible (voir le journal du serveur).');
  }

  // 5. Révocation immédiate des sessions des identités qui perdent l'exemption.
  const revoked: number[] = [];
  const revokeFailed: number[] = [];
  if (change.revokeSessionsOf.length) {
    const { revokeUserSessionsNow } = await import('@/services/admin/account-status.service');
    for (const uid of change.revokeSessionsOf) {
      try {
        await revokeUserSessionsNow(uid, 'APP_REVIEW_EXEMPTION_REVOKED');
        revoked.push(uid);
      } catch (error) {
        // L'exemption est déjà retirée : la décision MFA (sans cache) refuse
        // tout accès non conforme dès la requête suivante. Signalé au BO.
        console.error('[admin/accounts/app-review] révocation des sessions :', (error as Error)?.message ?? error);
        revokeFailed.push(uid);
      }
    }
  }

  await logAdminAction({
    adminId, action: 'APP_REVIEW_UPDATE', targetType: 'ACCOUNT', targetId: accountId, result: 'SUCCESS',
    before: change.before, after: change.after,
    details: { action, reason, userId: Number.isSafeInteger(userId) && userId > 0 ? userId : null, sessionsRevoked: revoked, sessionsRevokeFailed: revokeFailed },
  });
  return NextResponse.json({
    success: true, action, after: change.after,
    sessionsRevoked: revoked.length,
    ...(change.warning ? { warning: change.warning } : {}),
    ...(revokeFailed.length ? { warning: 'Sessions non révoquées pour certaines identités : utilisez « Déconnecter toutes les sessions » sur leur fiche.' } : {}),
  }, { headers: NO_STORE });
}
