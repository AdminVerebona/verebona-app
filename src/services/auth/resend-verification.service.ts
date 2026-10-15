/**
 * Renvoi de l'e-mail de vérification — traitement effectif, exécuté APRÈS la
 * réponse neutre de `/api/auth/resend-verification` (lot 37, C3).
 *
 * Lot 57A (P0-B) : le renvoi n'est plus une promesse en mémoire. La demande
 * est enregistrée en base (`transactional_email_jobs`) — ou la demande déjà
 * ouverte pour ce compte est relancée, sans doublon — puis tentée ; un échec
 * est repris par la tâche planifiée `transactional-emails-retry`. L'ancien
 * lien reste valable (lien signé, rien n'est invalidé par un renvoi).
 */
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { enqueueVerificationEmail, processEmailJob } from '@/services/email/transactional-email-jobs.service';

/**
 * Demande DURABLE enregistrée AVANT la réponse publique, pour toute adresse
 * (sans lire le compte : même coût, rien de révélé — lot 53A). La tentative
 * suit, après la réponse (`processEmailJob`).
 */
export async function recordVerificationResendRequest(normalizedEmail: string): Promise<number> {
  return (await enqueueVerificationEmail({ email: normalizedEmail })).jobId;
}

/**
 * Envoi effectif (après la réponse). Compte inconnu ou déjà vérifié : rien.
 * `sent` : accepté par le fournisseur ; `failed` : non accepté — la demande
 * reste ouverte et sera reprise (ou close après 6 tentatives).
 */
export async function resendVerification(normalizedEmail: string): Promise<'sent' | 'skipped' | 'failed'> {
  const [user] = await db
    .select({ id: users.id, email: users.email, isActive: users.isActive })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);
  if (!user || user.isActive) return 'skipped';

  const job = await enqueueVerificationEmail({ userId: user.id, email: user.email });
  const result = await processEmailJob(job.jobId);
  if (result.status === 'accepted') return 'sent';
  if (result.status === 'cancelled') return 'skipped';
  if (result.status === 'busy') return 'failed'; // tentative déjà en cours ailleurs

  // La cause et le remède restent lisibles — dans le journal du serveur.
  const cause = result.error ?? 'cause inconnue';
  const remede =
    /not found/i.test(cause)
      ? "Le gabarit d'email n'existe pas en base. Exécuter l'amorçage : GET /api/cron/seed?only=email-system"
      : /disabled/i.test(cause)
        ? 'Les emails sont désactivés globalement dans email_settings.'
        : /api key|unauthorized|401|not configured/i.test(cause)
          ? "Clé d'API du fournisseur absente ou refusée. Vérifier RESEND_API_KEY."
          : /domain|from/i.test(cause)
            ? "Domaine expéditeur non vérifié chez Resend. Voir docs/exploitation/emails-delivrabilite.md."
            : undefined;
  console.error('[resend-verification] EMAIL_SEND_FAILED :', cause, remede ? `— ${remede}` : '', `(demande #${result.jobId}, reprise automatique)`);
  return 'failed';
}
