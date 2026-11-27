import { db } from '@/db';
import { userActivityLog } from '@/db/schema';
import { NextRequest } from 'next/server';
import { getClientIp } from '@/lib/auth/client-ip';

type ActivityType = 'LOGIN_SUCCESS' | 'LOGIN_FAILED' | 'EMAIL_CHANGE' | 'PROFILE_UPDATE' | 'PASSWORD_CHANGE' | 'SERVER_ERROR' |
  // Evenements d'authentification (CDC cookies §13)
  'AUTH_TOKEN_REFRESH' | 'AUTH_TOKEN_REUSE_DETECTED' | 'AUTH_LOGOUT' |
  'AUTH_SESSION_REVOKED' | 'AUTH_SESSION_EXPIRED' |
  // Lot 53A (retour PO D1 / Q21, CDC 18 §23.1) : pause anti-force brute
  // déclenchée (connexion ou réauthentification), réinitialisation terminée,
  // inscription demandée sur une adresse déjà inscrite (aucun compte créé).
  'AUTH_LOGIN_THROTTLED' | 'AUTH_REAUTH_THROTTLED' | 'PASSWORD_RESET_COMPLETED' | 'SIGNUP_EXISTING_EMAIL' |
  // Lot 72D : changement d'espace (compte courant de la session).
  'ACCOUNT_SWITCHED' |
  // Lot 96A (CDC 18 Q9, Q8 ; §23.1 PRIMARY_EMAIL_CHANGED) : activation protégée
  // par le mot de passe de l'inscription ; changement de l'adresse principale.
  'ACCOUNT_ACTIVATED' | 'ACCOUNT_ACTIVATION_FAILED' | 'ACCOUNT_ACTIVATION_THROTTLED' |
  'PRIMARY_EMAIL_CHANGE_REQUESTED' | 'PRIMARY_EMAIL_CHANGE_REFUSED' | 'PRIMARY_EMAIL_CHANGED' |
  // Lot 92 (CDC 18 §23.1) : registre des sessions et réauthentification.
  'SESSION_CREATED' | 'SESSION_REVOKED' | 'REAUTH_SUCCESS' | 'REAUTH_FAILED' |
  // Lot 93 (CDC 18 §23.1) : Google / Apple — sans aucun jeton ni code.
  'OAUTH_START' | 'OAUTH_CALLBACK_SUCCESS' | 'OAUTH_CALLBACK_FAILED' | 'IDENTITY_LINKED' | 'IDENTITY_UNLINKED' |
  'PASSWORD_CREATED' | 'SOCIAL_SIGNUP' |
  // Lot 100D (décision PO A9) : résiliation (fin de période) demandée depuis l'application.
  'SUBSCRIPTION_RENEWAL_STOPPED' |
  // Lot 110B (MFA, ticket §7) : authentifications fortes, échecs, facteurs,
  // récupération, réglage d'obligation — jamais un code, un secret ni une clé.
  'MFA_CHALLENGE_STARTED' | 'MFA_SUCCESS' | 'MFA_FAILED' | 'MFA_THROTTLED' | 'MFA_FACTOR_ADDED' | 'MFA_FACTOR_REMOVED' |
  'MFA_RECOVERY_CODES_REGENERATED' | 'MFA_RECOVERY_USED' | 'MFA_ENFORCEMENT_CHANGED' | 'MFA_PASSKEY_COUNTER_REGRESSION' |
  // Carte #876 : connexion d'une identité de revue Apple / Google exemptée de
  // l'obligation GLOBALE (session de niveau 1) — surveillance des accès.
  'MFA_APP_REVIEW_EXEMPTION_APPLIED';

export interface LogActivityParams {
  activityType: ActivityType;
  userId?: number | null;
  userEmail: string;
  details?: Record<string, any>;
  request?: NextRequest;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Exécuteur d'une insertion dans le journal d'activité : la base (`db`) ou une
 * transaction Drizzle ouverte par l'appelant (carte #823).
 */
export type ActivityLogExecutor = Pick<typeof db, 'insert'>;

/**
 * Carte #823 — primitive d'insertion du journal d'activité.
 *
 * Contrairement à `logUserActivity`, elle PROPAGE toute erreur (préparation de
 * la ligne ou insertion) et accepte un exécuteur : passée à une transaction,
 * la trace est validée — ou annulée — AVEC le reste de cette transaction.
 * À réserver aux traces qui doivent être garanties avec l'état qu'elles
 * décrivent (pause de réauthentification : `auth/reauth-throttle.ts`).
 * Aucune donnée sensible n'y est ajoutée : la ligne est exactement celle de
 * `logUserActivity`.
 */
export async function insertUserActivity(params: LogActivityParams, executor: ActivityLogExecutor = db): Promise<void> {
  const {
    activityType,
    userId,
    userEmail,
    details,
    request,
    ipAddress: customIpAddress,
    userAgent: customUserAgent,
  } = params;

  // Extract IP and User Agent from request if provided
  let ipAddress = customIpAddress;
  let userAgent = customUserAgent;

  if (request) {
    // IP réelle derrière le routeur (lot 37) : la valeur la plus à gauche
    // de x-forwarded-for est fournie par le client — voir `client-ip.ts`.
    ipAddress = ipAddress || getClientIp(request.headers);

    userAgent = userAgent || request.headers.get('user-agent') || 'unknown';
  }

  await executor.insert(userActivityLog).values({
    timestamp: new Date(),
    userId: userId || null,
    userEmail,
    activityType,
    ipAddress: ipAddress || null,
    userAgent: userAgent || null,
    details: details ? JSON.stringify(details) : null,
    createdAt: new Date(),
  });
}

/**
 * Log user activity to the audit log
 *
 * Contrat INCHANGÉ (carte #823) : ne lève jamais — toute erreur est absorbée,
 * la journalisation ne doit pas casser le parcours appelant. La trace n'est
 * donc PAS garantie par cette fonction ; pour une trace garantie avec une
 * écriture, utiliser `insertUserActivity` dans la transaction de l'appelant.
 */
export async function logUserActivity(params: LogActivityParams): Promise<void> {
  try {
    await insertUserActivity(params);
  } catch {
    // Don't throw - logging should never break the main flow
  }
}
