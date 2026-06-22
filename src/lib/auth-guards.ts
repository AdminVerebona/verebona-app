import { NextRequest } from 'next/server';
import { SessionService } from '@/lib/session-service';

/**
 * Guards d'autorisation utilisant SessionService
 * 
 * PRINCIPE: Appeler directement getSession(request) qui lit le cookie JWT,
 * JAMAIS lire les headers x-user-id/x-user-role qui peuvent être spoofés.
 */

/**
 * Vérifie l'authentification et retourne userId
 * @throws Error si non authentifié
 */
export async function requireAuth(request: NextRequest): Promise<number> {
  return await SessionService.requireAuth(request);
}

/**
 * Vérifie le rôle ADMIN
 * @throws Error si pas admin
 */
export async function requireAdmin(request: NextRequest): Promise<number> {
  return await SessionService.requireAdmin(request);
}

/**
 * Vérifie la propriété d'une ressource
 * @throws Error si l'utilisateur n'est pas propriétaire
 */
export function assertOwnership(userId: number, resourceUserId: number): void {
  SessionService.assertOwnership(userId, resourceUserId);
}

/**
 * Récupère la session complète (avec tous les claims)
 */
export async function getSession(request: NextRequest) {
  return await SessionService.getSession(request);
}