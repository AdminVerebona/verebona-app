import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { validatePassword, getPasswordValidationError } from '@/lib/auth/password';
import { SessionService } from '@/lib/session-service';
import { emit } from '@/lib/notifications';
import { revokeAllUserSessions, revokeToken, hashToken } from '@/db';
import { serverCacheDelete } from '@/lib/server-cache';
import { clearSessionCookies, sessionSubjectFor, sessionCutoffCacheKey } from '@/lib/auth/session-tokens';
import { issueSession } from '@/lib/auth/session-issuance';
import { consumeReauthProof, getReauthState, reauthRequiredResponse } from '@/lib/auth/reauth';
import { reauthBlockedResponse, recordReauthFailure, recordReauthSuccess } from '@/lib/auth/reauth-throttle';
import { logUserActivity } from '@/lib/audit-logger';
import { REFRESH_TOKEN_TTL_S } from '@/lib/auth/token-lifetimes';

export async function POST(request: NextRequest) {
  try {
    const       session = await SessionService.getSession(request);
    const body = await request.json();
    const { currentPassword, newPassword } = body;
    // Conserver la session de cet appareil : uniquement sur choix explicite.
    const keepCurrentSession = body?.keepCurrentSession === true;

    if (!newPassword) {
      return NextResponse.json(
        { error: 'Données manquantes', message: 'Le nouveau mot de passe est requis.' },
        { status: 400 }
      );
    }

    // ══════════════════════════════════════════════════════════════════════
    // LOT 92 — RÉAUTHENTIFICATION (CDC 18 §18, REAUTH-01/02/06, Q7)
    //
    // Deux preuves acceptées, jamais aucune :
    //   · preuve de réauthentification fraîche (< 5 min) de CETTE session,
    //     émise par le serveur (`/api/users/me/security/reauth`) — l'écran
    //     Mon compte › Sécurité ne redemande plus le mot de passe actuel ;
    //   · ou, comme avant (clients non mis à jour), le mot de passe actuel
    //     dans la requête — même limiteur partagé (lot 53A).
    // Sans l'une ni l'autre : 403 REAUTH_REQUIRED / REAUTH_EXPIRED.
    // ══════════════════════════════════════════════════════════════════════
    const reauth = currentPassword ? null : await getReauthState(session.userId, session.sid);
    if (reauth && reauth.state !== 'fresh') {
      return reauthRequiredResponse(reauth.state === 'expired' ? 'REAUTH_EXPIRED' : 'REAUTH_REQUIRED');
    }

    // Get user from DB to check current password
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    if (!user) {
      return NextResponse.json(
        { error: 'Utilisateur introuvable', message: 'Utilisateur introuvable.' },
        { status: 404 }
      );
    }
    // Lot 93 (CDC 18 §10.2) : compte créé avec Google / Apple, sans mot de
    // passe — il s'AJOUTE (POST /api/users/me/password, après
    // réauthentification par le fournisseur), il ne se « change » pas.
    if (!user.passwordHash) {
      return NextResponse.json(
        {
          error: 'Aucun mot de passe',
          code: 'PASSWORD_NOT_SET',
          message: 'Votre compte n’a pas encore de mot de passe : utilisez « Ajouter un mot de passe ».',
        },
        { status: 409 }
      );
    }

    if (currentPassword) {
      // Lot 53A (CDC 18 §33) : réauthentification limitée — compteurs partagés,
      // par utilisateur et par IP (`lib/auth/reauth-throttle.ts`).
      const blocked = await reauthBlockedResponse(request, session.userId);
      if (blocked) return blocked;

      // Verify current password
      const isPasswordCorrect = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!isPasswordCorrect) {
        await recordReauthFailure(request, session.userId, 'change_password');
        return NextResponse.json(
          // Code stable : un 401 de saisie n'est pas une session expirée, le
          // client ne doit pas renouveler la session pour autant (APP-PERF-20).
          { error: 'Mot de passe incorrect', code: 'INVALID_CURRENT_PASSWORD', message: 'L\'ancien mot de passe est incorrect.' },
          { status: 401 }
        );
      }

      await recordReauthSuccess(session.userId);
    }

    // Validate new password strength
    if (!validatePassword(newPassword)) {
      return NextResponse.json(getPasswordValidationError(), { status: 400 });
    }

    // Action à risque maximal : la preuve est CONSOMMÉE (usage unique).
    if (reauth?.state === 'fresh' && !(await consumeReauthProof(reauth.proof.id, 'change_password'))) {
      return reauthRequiredResponse('REAUTH_EXPIRED');
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    // Update user
    await db
      .update(users)
      .set({
        passwordHash: newPasswordHash,
        updatedAt: new Date(),
      })
      .where(eq(users.id, session.userId));

    // ══════════════════════════════════════════════════════════════════════
    // RÉVOCATION DE TOUTES LES SESSIONS
    //
    // Les jetons de renouvellement déjà émis restaient utilisables : un autre
    // navigateur pouvait continuer à renouveler sa session avec un ancien
    // jeton. Tout jeton émis avant ce changement est désormais refusé par
    // `/api/auth/refresh` (même système de révocation) et par la vérification
    // de session. Le jeton de renouvellement présenté ici est aussi révoqué :
    // sa réutilisation sera détectée comme telle.
    // ══════════════════════════════════════════════════════════════════════
    const cutoff = await revokeAllUserSessions(session.userId, 'PASSWORD_CHANGED');
    serverCacheDelete(sessionCutoffCacheKey(session.userId));
    const presented = request.cookies.get('refresh_token')?.value;
    if (presented) {
      await revokeToken(await hashToken(presented), session.userId, new Date(Date.now() + REFRESH_TOKEN_TTL_S * 1000))
        .catch((e) => console.error('[change-password] révocation du jeton courant :', e));
    }

    // Journal interne (CDC 18 §23.1 PASSWORD_CHANGED) — sans aucun secret.
    void logUserActivity({
      activityType: 'PASSWORD_CHANGE',
      userId: session.userId,
      userEmail: user.email,
      details: { sessionsRevoked: true, keepCurrentSession, reauth: currentPassword ? 'inline_password' : 'proof' },
      request,
    });

    // Événement de sécurité obligatoire (cloche + email, CDC §7.7).
    try {
      await emit({
        type: 'PASSWORD_CHANGED',
        recipientUserIds: [session.userId],
        entityType: 'user',
        entityId: session.userId,
        payload: {},
        dedupeKey: `security:password-changed:${session.userId}:${Date.now()}`,
      });
    } catch (err) {
      console.error('[change-password] emit PASSWORD_CHANGED échoué:', err);
    }

    // Par défaut, reconnexion partout, cet appareil compris. Sur choix
    // explicite, cet appareil reçoit une session neuve (émise après la
    // révocation, donc valide) ; les autres restent déconnectés.
    const response = NextResponse.json({
      message: 'Mot de passe mis à jour avec succès',
      sessionsRevoked: true,
      reauthRequired: !keepCurrentSession,
    });
    if (keepCurrentSession) {
      // La session neuve doit être émise strictement APRÈS la borne.
      while (Date.now() <= cutoff.getTime()) await new Promise((r) => setTimeout(r, 1));
      // Lot 92 : session neuve qui remplace celle de cet appareil (registre).
      await issueSession(request, response, { kind: 'open', method: 'session_reopen', replaceCurrent: true, subject: await sessionSubjectFor(user) });
    } else {
      clearSessionCookies(response);
    }
    return response;
  } catch (error) {
    console.error('[CHANGE_PASSWORD_ERROR]', error);
    return SessionService.handleSessionError(error);
  }
}
