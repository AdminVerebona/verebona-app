import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { emailService } from '@/lib/email/email-service';

/**
 * Route pour demander un reset de mot de passe
 * 
 * Body: { email: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email } = body;
    
    if (!email) {
      return NextResponse.json(
        { error: 'Email requis' },
        { status: 400 }
      );
    }
    
    // Trouver l'utilisateur
    const userResult = await db
      .select()
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(1);
    
    // Ne pas révéler si l'email existe ou non (sécurité)
    if (userResult.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'Si un compte existe avec cet email, un lien de réinitialisation a été envoyé.'
      });
    }
    
    const user = userResult[0];
    
    // Générer token de reset (format: base64(email:timestamp))
    const timestamp = Date.now();
    const tokenData = `${user.email}:${timestamp}`;
    const token = Buffer.from(tokenData).toString('base64');
    
    const baseUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const resetUrl = `${baseUrl}/reset-password?token=${token}`;
    
    // Envoyer email de reset
    const result = await emailService.send({
      templateCode: 'PASSWORD_RESET',
      to: user.email,
      variables: {
        firstName: user.firstName,
        resetUrl,
        expiresAt: '1 heure',
      },
      userId: user.id,
    });
    
    if (!result.success) {
      console.error('Failed to send password reset email:', result.error);
      return NextResponse.json(
        { error: 'Erreur lors de l\'envoi de l\'email' },
        { status: 500 }
      );
    }
    
    
    return NextResponse.json({
      success: true,
      message: 'Si un compte existe avec cet email, un lien de réinitialisation a été envoyé.'
    });
    
  } catch (error) {
    console.error('Forgot password error:', error);
    return NextResponse.json(
      { error: 'Erreur interne du serveur' },
      { status: 500 }
    );
  }
}
