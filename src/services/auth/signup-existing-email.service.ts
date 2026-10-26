/**
 * Inscription NON ÉNUMÉRABLE — e-mail « vous avez déjà un compte » (lot 53A,
 * retour PO Q21 ; CDC 18 §7.1, §9.1, §40 « tests anti-énumération »).
 *
 * L'inscription répond désormais de la même façon qu'une adresse soit libre
 * ou déjà inscrite (« Vérifiez votre boîte mail »). Seul le PROPRIÉTAIRE de
 * la boîte apprend ce qui s'est passé :
 *   · adresse libre → e-mail d'activation (lien signé 24 h, usage unique) ;
 *   · adresse déjà inscrite → CET e-mail : aucun compte créé, lien de
 *     connexion et lien « Mot de passe oublié », « ignorez ce message si ce
 *     n'était pas vous ».
 *
 *   · APRÈS la réponse (`runDetached`) : la réponse n'attend aucun envoi ;
 *   · au plus UN par adresse et par heure (compteur partagé, clé
 *     pseudonymisée) : on ne peut pas inonder la boîte d'un titulaire ;
 *   · gabarit `SIGNUP_EXISTING_ACCOUNT` (migration 0342), modifiable et
 *     désactivable dans BO › Communications ;
 *   · variables limitées : prénom, date de la demande, deux liens publics.
 */
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { AUTH_LIMITS, getAuthRateLimiter, limitKey } from '@/lib/auth/auth-rate-limit';
import { runDetached } from '@/lib/auth/anti-enumeration';
import { formatSecurityIncidentDate } from '@/lib/auth/security-email';

export const SIGNUP_EXISTING_ACCOUNT_TEMPLATE = 'SIGNUP_EXISTING_ACCOUNT';

type SignupExistingEmailOutcome = 'sent' | 'throttled' | 'no_recipient' | 'failed';

function appUrl(): string {
  return process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

/** Variables du gabarit — liste FERMÉE. */
export function signupExistingEmailVariables(p: { firstName: string | null; at: Date; appUrl: string }): Record<string, string> {
  const base = p.appUrl.replace(/\/$/, '');
  return {
    firstName: p.firstName?.trim() || '',
    requestDate: formatSecurityIncidentDate(p.at),
    loginUrl: `${base}/login`,
    forgotPasswordUrl: `${base}/forgot-password`,
  };
}

/** Envoi (attendu) — exposé pour les tests ; la route passe par `scheduleSignupExistingEmail`. */
async function sendSignupExistingEmail(userId: number, at: Date = new Date()): Promise<SignupExistingEmailOutcome> {
  const [user] = await db
    .select({ email: users.email, firstName: users.firstName, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.email || user.status === 'DELETED') return 'no_recipient';

  const decision = await getAuthRateLimiter().consume([
    { key: limitKey('signup', 'acct', user.email.trim().toLowerCase()), policy: AUTH_LIMITS.signupExistingEmail },
  ]);
  if (!decision.allowed) return 'throttled';

  const { emailService } = await import('@/lib/email/email-service');
  const res = await emailService.send({
    templateCode: SIGNUP_EXISTING_ACCOUNT_TEMPLATE,
    to: user.email,
    userId,
    variables: signupExistingEmailVariables({ firstName: user.firstName ?? null, at, appUrl: appUrl() }),
  });
  return res?.success ? 'sent' : 'failed';
}

/** Planifie l'envoi APRÈS la réponse ; ne lève jamais. */
export function scheduleSignupExistingEmail(userId: number, at: Date = new Date()): void {
  runDetached('e-mail « vous avez déjà un compte »', async () => {
    const issue = await sendSignupExistingEmail(userId, at);
    if (issue === 'failed') console.error('[signup] envoi de l’e-mail « compte existant » en échec (utilisateur', userId, ')');
  });
}
