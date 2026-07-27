import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { validatePassword, getPasswordValidationError } from '@/lib/auth/password';
import { emit } from '@/lib/notifications';

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
    
    // Décoder le token
    let email: string;
    let timestamp: number;
    
    try {
      const decoded = Buffer.from(token, 'base64').toString('utf-8');
      const [emailPart, timestampPart] = decoded.split(':');
      email = emailPart;
      timestamp = parseInt(timestampPart, 10);
      
      // Vérifier que le token n'a pas expiré (1 heure)
      const now = Date.now();
      const expiryTime = 60 * 60 * 1000; // 1 heure
      
      if (now - timestamp > expiryTime) {
        return NextResponse.json(
          { error: 'Token expiré', code: 'TOKEN_EXPIRED' },
          { status: 400 }
        );
      }
    } catch {
      return NextResponse.json(
        { error: 'Token invalide', code: 'INVALID_TOKEN' },
        { status: 400 }
      );
    }
    
    // Trouver l'utilisateur
    const userResult = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
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
