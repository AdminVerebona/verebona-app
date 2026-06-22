import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { emailService } from '@/lib/email/email-service';

/**
 * Route pour renvoyer l'email de vérification
 * 
 * Body: { email: string }
 * 
 * Rate limiting: Max 3 par heure par email (à implémenter si nécessaire)
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
        message: 'Si cet email existe, un nouveau lien de vérification a été envoyé.'
      });
    }
    
    const user = userResult[0];
    
    // Si déjà actif, ne rien faire
    if (user.isActive) {
      return NextResponse.json({
        success: true,
        message: 'Ce compte est déjà vérifié.',
        alreadyVerified: true
      });
    }
    
    // Générer nouveau token de vérification
    const timestamp = Date.now();
    const tokenData = `${user.email}:${timestamp}`;
    const token = Buffer.from(tokenData).toString('base64');
    
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const verificationUrl = `${baseUrl}/api/auth/verify-email?token=${token}`;
    
    // Envoyer email de vérification
    const result = await emailService.send({
      templateCode: 'EMAIL_VERIFICATION',
      to: user.email,
      variables: {
        firstName: user.firstName,
        verificationUrl,
      },
      userId: user.id,
    });
    
    if (!result.success) {
      console.error('Failed to send verification email:', result.error);
      return NextResponse.json(
        { error: 'Erreur lors de l\'envoi de l\'email' },
        { status: 500 }
      );
    }
    
    
    return NextResponse.json({
      success: true,
      message: 'Un nouveau lien de vérification a été envoyé.'
    });
    
  } catch (error) {
    console.error('Resend verification error:', error);
    return NextResponse.json(
      { error: 'Erreur interne du serveur' },
      { status: 500 }
    );
  }
}
