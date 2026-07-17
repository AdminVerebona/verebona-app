import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from './jwt';
import { ApiErrors } from './api-errors';
import type { PlanType, UserRole, UserStatus } from '@/types/domain';
import { db } from '@/db';
import { users, accounts } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { serverCacheGet, serverCacheSet } from './server-cache';

/**
 * Session payload extrait du JWT.
 * Les types sont importés depuis domain.ts — source de vérité unique.
 */
export interface SessionPayload {
  userId: number;
  email: string;
  role: UserRole;
  status: UserStatus;
  planType: PlanType;
  currentAccountId?: number;
}

/**
 * Service de gestion de session sécurisé
 *
 * PRINCIPE: Lire le token depuis Authorization header (priorité) ou cookie (fallback)
 * Nécessaire pour compatibilité iframe où les cookies ne fonctionnent pas toujours.
 */
export class SessionService {
  /**
   * Extrait et vérifie la session depuis le JWT.
   * Lit d'abord le header Authorization, puis le cookie en fallback.
   *
   * @throws Error si token invalide ou manquant
   */
  static async getSession(request: NextRequest): Promise<SessionPayload> {
    let token: string | undefined;

    const authHeader = request.headers.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }

    if (!token) {
      token = request.cookies.get('access_token')?.value;
    }

    if (!token) {
      throw new Error('AUTH_REQUIRED');
    }

    const payload = await verifyToken(token);

    if (!payload) {
      throw new Error('INVALID_TOKEN');
    }

    if (!payload.userId || !payload.email || !payload.role || !payload.status) {
      console.error('[SessionService] JWT payload invalide ou incomplet:', payload);
      throw new Error('INVALID_TOKEN');
    }

    if (payload.status === 'SUSPENDED' || payload.status === 'DELETED') {
      throw new Error('ACCOUNT_SUSPENDED');
    }

    // Contrôle de fin de grâce réactive — cache 60s pour éviter une query DB
    // sur chaque appel API. Le JWT contient déjà userId, currentAccountId, planType, hasActiveAccount.
    if (payload.currentAccountId) {
      const graceCacheKey = `grace:${payload.currentAccountId}`;
      const graceExpired = serverCacheGet<boolean>(graceCacheKey);

      if (graceExpired === undefined) {
        // Cache froid : vérifier DB
        const [account] = await db
          .select({
            subscriptionStatus: accounts.subscriptionStatus,
            pastDueGraceEndsAt: accounts.pastDueGraceEndsAt,
          })
          .from(accounts)
          .where(eq(accounts.id, payload.currentAccountId))
          .limit(1);

        if (account) {
          if (account.subscriptionStatus === 'PAST_DUE_GRACE') {
            const now = new Date();
            if (account.pastDueGraceEndsAt && now > account.pastDueGraceEndsAt) {
              await db
                .update(accounts)
                .set({ subscriptionStatus: 'EXPIRED', updatedAt: now })
                .where(eq(accounts.id, payload.currentAccountId));
              serverCacheSet(graceCacheKey, true, 60_000);
              throw new Error('TRIAL_ACTIVATION_PENDING');
            }
            // Grace pas encore expirée → cacher qu'elle est toujours valide
            serverCacheSet(graceCacheKey, false, 60_000);
          } else {
            // Pas en grace → cacher l'absence de problème
            serverCacheSet(graceCacheKey, false, 60_000);
          }
        }
      } else if (graceExpired === true) {
        throw new Error('TRIAL_ACTIVATION_PENDING');
      }
      // graceExpired === false : rien à faire, la grâce n'est pas expirée
    }

    return {
      userId: payload.userId,
      email: payload.email,
      role: payload.role as UserRole,
      status: payload.status as UserStatus,
      planType: payload.planType as PlanType,
      currentAccountId: payload.currentAccountId,
    };
  }

  /**
   * Tente de récupérer la session sans throw.
   * @returns SessionPayload | null
   */
  static async tryGetSession(request: NextRequest): Promise<SessionPayload | null> {
    try {
      return await this.getSession(request);
    } catch {
      return null;
    }
  }

  /**
   * Vérifie que l'utilisateur est authentifié.
   * @returns userId
   * @throws Error si non authentifié
   */
  static async requireAuth(request: NextRequest): Promise<number> {
    const session = await this.getSession(request);
    return session.userId;
  }

  /**
   * Vérifie que l'utilisateur est ADMIN ou SUPER_ADMIN.
   * @returns userId
   * @throws Error si pas admin
   */
  static async requireAdmin(request: NextRequest): Promise<number> {
    const session = await this.getSession(request);

    // JWT role is the fast path — but if the user was promoted after token issuance,
    // fall back to the actual DB role to avoid stale-JWT lockout.
    let effectiveRole: string = session.role;
    if (effectiveRole !== 'ADMIN' && effectiveRole !== 'SUPER_ADMIN') {
      const [row] = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, session.userId))
        .limit(1);
      effectiveRole = row?.role ?? effectiveRole;
    }

    if (effectiveRole !== 'ADMIN' && effectiveRole !== 'SUPER_ADMIN') {
      throw new Error('INSUFFICIENT_PERMISSIONS');
    }

    return session.userId;
  }

  /**
   * Vérifie la propriété d'une ressource.
   * @throws Error si l'utilisateur n'est pas propriétaire
   */
  static assertOwnership(userId: number, resourceUserId: number): void {
    if (userId !== resourceUserId) {
      throw new Error('FORBIDDEN');
    }
  }

  /**
   * Helper pour convertir les erreurs SessionService en réponses HTTP.
   * Utiliser dans les routes API avec try/catch.
   */
  static handleSessionError(error: unknown): NextResponse {
    const errorMessage = (error as Error).message;

    switch (errorMessage) {
      case 'AUTH_REQUIRED':
        return ApiErrors.authRequired();
      case 'INVALID_TOKEN':
        return ApiErrors.invalidToken();
      case 'ACCOUNT_SUSPENDED':
        return ApiErrors.accountSuspended();
      case 'INSUFFICIENT_PERMISSIONS':
        return ApiErrors.insufficientPermissions();
      case 'FORBIDDEN':
        return ApiErrors.accessDenied('Access denied to this resource');
      case 'TRIAL_ACTIVATION_PENDING':
        return NextResponse.json(
          {
            error: 'Forbidden',
            code: 'TRIAL_ACTIVATION_PENDING',
            message: 'Votre période de grâce a expiré. Veuillez activer votre abonnement pour continuer.',
          },
          { status: 403 }
        );
      default:
        return ApiErrors.internalError('An unexpected error occurred');
    }
  }
}
