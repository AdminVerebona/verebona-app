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
/**
 * Codes d'erreur levés par les gardes de session (`requireAuth`,
 * `requireAdmin`, `getSession`).
 *
 * Les routes admin les interceptent pour répondre 401/403 au lieu d'un 500 :
 * un refus d'accès n'est pas une panne et ne doit pas être journalisé comme
 * telle (CDC BO GEN-002).
 */
const SESSION_ERROR_CODES = new Set([
  'AUTH_REQUIRED',
  'INVALID_TOKEN',
  'ACCOUNT_SUSPENDED',
  'INSUFFICIENT_PERMISSIONS',
  'FORBIDDEN',
  'TRIAL_ACTIVATION_PENDING',
]);

/** Vrai si l'erreur provient d'une garde de session (refus d'accès). */
export function isSessionError(error: unknown): boolean {
  return error instanceof Error && SESSION_ERROR_CODES.has(error.message);
}

/** Réponse HTTP d'un refus de garde de session (401/403). */
export function sessionErrorResponse(error: unknown) {
  return SessionService.handleSessionError(error);
}
