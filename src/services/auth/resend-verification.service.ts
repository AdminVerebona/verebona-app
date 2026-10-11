/**
 * Renvoi de l'e-mail de vérification — traitement effectif, exécuté APRÈS la
 * réponse neutre de `/api/auth/resend-verification` (lot 37, C3).
 */
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { emailService } from '@/lib/email/email-service';
import { buildEmailVerificationUrl } from '@/services/auth/email-verification.service';

/** Envoi effectif (après la réponse). Compte inconnu ou déjà vérifié : rien. */
export async function resendVerification(normalizedEmail: string): Promise<'sent' | 'skipped' | 'failed'> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);
  if (!user || user.isActive) return 'skipped';

  // Nouveau lien SIGNÉ (voir `email-verification.service`). C'est aussi
  // la sortie proposée aux titulaires d'un lien émis avant ce format.
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || 'http://localhost:3000';
  const verificationUrl = buildEmailVerificationUrl(baseUrl, { id: user.id, email: user.email });

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
    // La cause et le remède restent lisibles — dans le journal du serveur.
    const cause = result.error ?? 'cause inconnue';
    const remede =
      /not found/i.test(cause)
        ? "Le gabarit d'email n'existe pas en base. Exécuter l'amorçage : GET /api/cron/seed?only=email-system"
        : /disabled/i.test(cause)
          ? 'Les emails sont désactivés globalement dans email_settings.'
          : /api key|unauthorized|401/i.test(cause)
            ? "Clé d'API du fournisseur absente ou refusée. Vérifier RESEND_API_KEY."
            : undefined;
    console.error('[resend-verification] EMAIL_SEND_FAILED :', cause, remede ? `— ${remede}` : '');
    return 'failed';
  }
  return 'sent';
}
