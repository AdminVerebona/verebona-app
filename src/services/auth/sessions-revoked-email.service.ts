/**
 * E-mail de sécurité après la révocation de toutes les sessions pour
 * RÉUTILISATION d'un jeton de renouvellement — lot 38, volet B (décision PO ;
 * suite du lot 37, C2 ; CDC 18 §19.3).
 *
 * « Par précaution, nous avons déconnecté vos appareils… reconnectez-vous ;
 * si ce n'était pas vous, changez votre mot de passe » (lien « Mot de passe
 * oublié »).
 *
 *   · APRÈS la réponse (`runDetached`) : le renouvellement n'attend jamais
 *     l'envoi, et un échec d'envoi ne change rien à la réponse 401 ;
 *   · au plus UN e-mail par utilisateur et par heure : compteur PARTAGÉ entre
 *     les instances (`auth_rate_limits`, clé pseudonymisée, politique
 *     `securityEmailUser`) — un attaquant qui rejoue le jeton volé en boucle
 *     ne provoque pas une rafale d'e-mails ;
 *   · gabarit système `SECURITY_SESSIONS_REVOKED` (migration 0314),
 *     modifiable et désactivable dans le BO ; expéditeur des réglages e-mail
 *     du BO (`emailService`) ;
 *   · aucune donnée sensible : variables limitées à prénom, date de
 *     l'incident et deux liens publics (`sessionsRevokedEmailVariables`) —
 *     ni IP, ni appareil, ni jeton.
 */
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { AUTH_LIMITS, getAuthRateLimiter, limitKey } from '@/lib/auth/auth-rate-limit';
import { runDetached } from '@/lib/auth/anti-enumeration';
import { SESSIONS_REVOKED_TEMPLATE, sessionsRevokedEmailVariables } from '@/lib/auth/security-email';

export type SessionsRevokedEmailOutcome = 'sent' | 'throttled' | 'no_recipient' | 'failed';

function appUrl(): string {
  return process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

/** Envoi (attendu) — exposé pour les tests ; la route passe par `scheduleSessionsRevokedEmail`. */
export async function sendSessionsRevokedEmail(userId: number, at: Date = new Date()): Promise<SessionsRevokedEmailOutcome> {
  const [user] = await db
    .select({ email: users.email, firstName: users.firstName, isActive: users.isActive, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  // Compte supprimé ou sans adresse : personne à prévenir.
  if (!user?.email || user.status === 'DELETED') return 'no_recipient';

  // Anti-spam AVANT l'envoi : un échec du fournisseur ne rouvre pas la vanne.
  const decision = await getAuthRateLimiter().consume([
    { key: limitKey('security-email', 'acct', String(userId)), policy: AUTH_LIMITS.securityEmailUser },
  ]);
  if (!decision.allowed) return 'throttled';

  const { emailService } = await import('@/lib/email/email-service');
  const res = await emailService.send({
    templateCode: SESSIONS_REVOKED_TEMPLATE,
    to: user.email,
    userId,
    variables: sessionsRevokedEmailVariables({ firstName: user.firstName ?? null, at, appUrl: appUrl() }),
  });
  return res?.success ? 'sent' : 'failed';
}

/** Planifie l'envoi APRÈS la réponse ; ne lève jamais. */
export function scheduleSessionsRevokedEmail(userId: number, at: Date = new Date()): void {
  runDetached('e-mail de sécurité (sessions révoquées)', async () => {
    const issue = await sendSessionsRevokedEmail(userId, at);
    if (issue === 'failed') console.error('[security-email] envoi de l’e-mail « appareils déconnectés » en échec (utilisateur', userId, ')');
  });
}
