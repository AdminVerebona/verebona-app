import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { validatePassword, getPasswordValidationError } from '@/lib/auth/password';
import { emit } from '@/lib/notifications';
import { revokeAllUserSessions } from '@/db';
import { serverCacheDelete } from '@/lib/server-cache';
import { sessionCutoffCacheKey } from '@/lib/auth/session-cutoff';
import { verifyPasswordResetToken } from '@/services/auth/password-reset.service';

/**
 * Route pour réinitialiser le mot de passe avec un token
 * 
 * Body: { token: string, newPassword: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, newPassword } = body;
    
    if (!token || !newPassword) {
      return NextResponse.json(
        { error: 'Token et nouveau mot de passe requis' },
        { status: 400 }
      );
    }
    
    // Valider le nouveau mot de passe
    if (!validatePassword(newPassword)) {
      return NextResponse.json(
        getPasswordValidationError(),
        { status: 400 }
      );
    }
    
    // Jeton SIGNÉ et à usage unique (voir `services/auth/password-reset.service.ts`) :
    // l'ancien format `base64(email:horodatage)` permettait à quiconque de
    // fabriquer un lien valide pour n'importe quelle adresse.
    if (typeof token !== 'string') {
      return NextResponse.json({ error: 'Token invalide', code: 'INVALID_TOKEN' }, { status: 400 });
    }
    const check = await verifyPasswordResetToken(token);
    if (!check.ok) {
      return NextResponse.json(
        check.code === 'TOKEN_EXPIRED'
          ? { error: 'Token expiré', code: 'TOKEN_EXPIRED' }
          : { error: 'Token invalide', code: 'INVALID_TOKEN' },
        { status: 400 }
      );
    }

    // Trouver l'utilisateur
    const userResult = await db
      .select()
      .from(users)
      .where(eq(users.id, check.userId))
      .limit(1);

    if (userResult.length === 0) {
      return NextResponse.json(
        { error: 'Utilisateur non trouvé', code: 'USER_NOT_FOUND' },
        { status: 404 }
      );
    }

    const user = userResult[0];
    
    // Hasher le nouveau mot de passe
    const passwordHash = await bcrypt.hash(newPassword, 10);
    
    // Mettre à jour le mot de passe
    await db
      .update(users)
      .set({ 
        passwordHash,
        updatedAt: new Date()
      })
      .where(eq(users.id, user.id));
    
    // Réinitialisation = même risque qu'un changement : toutes les sessions
    // existantes (y compris celle d'un éventuel intrus) sont révoquées.
    await revokeAllUserSessions(user.id, 'PASSWORD_RESET');
    serverCacheDelete(sessionCutoffCacheKey(user.id));

    // Événement de sécurité obligatoire (cloche + email, CDC §7.7).
    try {
      await emit({
        type: 'PASSWORD_RESET_COMPLETED',
        recipientUserIds: [user.id],
        entityType: 'user',
        entityId: user.id,
        payload: {},
        // Une réinitialisation par occurrence (l'horodatage garantit l'unicité).
        dedupeKey: `security:password-reset:${user.id}:${Date.now()}`,
      });
    } catch (err) {
      console.error('[reset-password] emit PASSWORD_RESET_COMPLETED échoué:', err);
    }

    return NextResponse.json({
      success: true,
      message: 'Mot de passe réinitialisé avec succès'
    });
    
  } catch (error) {
    console.error('Reset password error:', error);
    return NextResponse.json(
      { error: 'Erreur interne du serveur' },
      { status: 500 }
    );
  }
}
