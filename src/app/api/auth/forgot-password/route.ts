import { NextRequest, NextResponse } from 'next/server';
import { startPasswordReset } from '@/services/auth/password-reset.service';

/**
 * Route pour demander un reset de mot de passe
 *
 * Body: { email: string }
 *
 * La logique (jeton signé, e-mail `PASSWORD_RESET`) vit dans
 * `services/auth/password-reset.service.ts`, partagée avec l'action
 * administrateur « Réinitialiser le mot de passe » (CDC BO USR-A07) : les deux
 * déclencheurs suivent strictement le même parcours.
 */
const MESSAGE_NEUTRE = 'Si un compte existe avec cet email, un lien de réinitialisation a été envoyé.';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email } = body;

    if (!email || typeof email !== 'string') {
      return NextResponse.json(
        { error: 'Email requis' },
        { status: 400 }
      );
    }

    const result = await startPasswordReset(email);

    // Ne pas révéler si l'email existe ou non (sécurité)
    if (result.status === 'unknown_email') {
      return NextResponse.json({ success: true, message: MESSAGE_NEUTRE });
    }

    if (result.status === 'send_failed') {
      return NextResponse.json(
        { error: 'Erreur lors de l\'envoi de l\'email' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, message: MESSAGE_NEUTRE });
  } catch (error) {
    console.error('Forgot password error:', error);
    return NextResponse.json(
      { error: 'Erreur interne du serveur' },
      { status: 500 }
    );
  }
}
