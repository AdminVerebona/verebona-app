import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { validatePassword, getPasswordValidationError } from '@/lib/auth/password';
import { SessionService } from '@/lib/session-service';

export async function POST(request: NextRequest) {
  try {
    const       session = await SessionService.getSession(request);
    const body = await request.json();
    const { currentPassword, newPassword } = body;

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

    return NextResponse.json({ message: 'Mot de passe mis à jour avec succès' });
  } catch (error) {
    console.error('[CHANGE_PASSWORD_ERROR]', error);
    return SessionService.handleSessionError(error);
  }
}
