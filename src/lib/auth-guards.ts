import { NextRequest } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { isKnownSessionError, sessionErrorToResponse } from '@/lib/auth/session-errors';

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
 * Les routes admin les interceptent pour répondre 401/403 (503 si la
 * vérification est impossible) au lieu d'un 500 : un refus d'accès n'est pas
 * une panne et ne doit pas être journalisé comme telle (CDC BO GEN-002).
 * Liste et réponses : `lib/auth/session-errors.ts` (APP-PERF-20).
 */

/** Vrai si l'erreur provient d'une garde de session (refus d'accès ou vérification impossible). */
export function isSessionError(error: unknown): boolean {
  return isKnownSessionError(error);
}

/** Réponse HTTP d'un refus de garde de session (401/403/503), avec `requestId`. */
export function sessionErrorResponse(error: unknown, requestId?: string) {
  return sessionErrorToResponse(error, requestId);
}
