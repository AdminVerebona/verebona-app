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
  'AUTH_LOGIN_THROTTLED' | 'AUTH_REAUTH_THROTTLED' | 'PASSWORD_RESET_COMPLETED' | 'SIGNUP_EXISTING_EMAIL';

interface LogActivityParams {
  activityType: ActivityType;
  userId?: number | null;
  userEmail: string;
  details?: Record<string, any>;
  request?: NextRequest;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Log user activity to the audit log
 */
export async function logUserActivity(params: LogActivityParams): Promise<void> {
  try {
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

    await db.insert(userActivityLog).values({
      timestamp: new Date(),
      userId: userId || null,
      userEmail,
      activityType,
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
      details: details ? JSON.stringify(details) : null,
      createdAt: new Date(),
    });

  } catch {
    // Don't throw - logging should never break the main flow
  }
}
