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
import { clearSessionCookies, issueSessionTokens, setSessionCookies, sessionCutoffCacheKey } from '@/lib/auth/session-tokens';

export async function POST(request: NextRequest) {
  try {
    const       session = await SessionService.getSession(request);
    const body = await request.json();
    const { currentPassword, newPassword } = body;
    // Conserver la session de cet appareil : uniquement sur choix explicite.
    const keepCurrentSession = body?.keepCurrentSession === true;

    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { error: 'Données manquantes', message: 'L\'ancien et le nouveau mot de passe sont requis.' },
        { status: 400 }
      );
    }

    // Get user from DB to check current password
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    if (!user || !user.passwordHash) {
      return NextResponse.json(
        { error: 'Utilisateur introuvable', message: 'Utilisateur introuvable.' },
        { status: 404 }
      );
    }

    // Verify current password
    const isPasswordCorrect = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isPasswordCorrect) {
      return NextResponse.json(
        { error: 'Mot de passe incorrect', message: 'L\'ancien mot de passe est incorrect.' },
        { status: 401 }
      );
    }

    // Validate new password strength
    if (!validatePassword(newPassword)) {
      return NextResponse.json(getPasswordValidationError(), { status: 400 });
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
      await revokeToken(await hashToken(presented), session.userId, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000))
        .catch((e) => console.error('[change-password] révocation du jeton courant :', e));
    }

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
      setSessionCookies(response, await issueSessionTokens(user));
    } else {
      clearSessionCookies(response);
    }
    return response;
  } catch (error) {
    console.error('[CHANGE_PASSWORD_ERROR]', error);
    return SessionService.handleSessionError(error);
  }
}
