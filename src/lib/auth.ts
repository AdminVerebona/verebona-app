import { NextRequest } from 'next/server';
import { extractAccessToken } from './auth/token-extractor';
import { sessionStatusAllows, verifySessionAccessToken } from './auth/session-guard';
import type { UserRole, UserStatus } from '@/types/domain';

export interface CurrentUser {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  status: UserStatus;
}

/**
 * Get current authenticated user from request headers or cookies
 * Uses JWT Access Token
 */
export async function getCurrentUser(request: NextRequest): Promise<CurrentUser | null> {
  const token = extractAccessToken(request);

  // Garde rétablie : le codemod de migration l'a retirée à tort. `token` est
  // ici extrait de la requête serveur — en-tête ou cookie — et non du
  // stockage du navigateur. Sans elle, une requête anonyme lève au lieu de
  // rendre `null`, ce qui transformerait chaque appel non authentifié en 500.
  if (!token) {
    return null;
  }

  // Borne de révocation et statut de session (`lib/auth/session-guard`) :
  // un jeton émis avant une révocation globale — changement de mot de passe,
  // clôture du compte — est refusé tout de suite, pas à son expiration.
  const payload = await verifySessionAccessToken(token, request);
  if (!payload || !payload.userId) {
    return null;
  }
  
  try {
    const { db } = await import('@/db');
    const { users } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');

    const userResult = await db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
        status: users.status,
      })
      .from(users)
      .where(eq(users.id, payload.userId))
      .limit(1);

    if (userResult.length === 0) {
      return null;
    }

    const user = userResult[0];
    // Statut RÉEL en base (le jeton peut dater d'avant une clôture).
    if (!sessionStatusAllows(user.status, request.nextUrl?.pathname ?? '', request.method ?? 'GET')) {
      return null;
    }
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role as UserRole,
      status: user.status as UserStatus,
    };
  } catch (error) {
    console.error('getCurrentUser error:', error);
    return null;
  }
}

/**
 * Client-side auth helper
 * Gets user from localStorage
 */
export function getClientUser(): { id: number; email: string } | null {
  if (typeof window === 'undefined') return null;
  
  const userStr = localStorage.getItem('user');
  if (!userStr) return null;
  
  try {
    return JSON.parse(userStr);
  } catch {
    return null;
  }
}
