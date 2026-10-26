import { NextRequest } from 'next/server';

/**
 * Extrait le token d'accès depuis la requête
 * Priorité: Authorization header > Cookie
 * 
 * Compatible avec architecture iframe où localStorage + Bearer token
 * est la méthode recommandée
 */
export function extractAccessToken(request: NextRequest): string | null {
  // 1. Authorization header (prioritaire)
  const authHeader = request.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring('Bearer '.length).trim();
    if (token.length > 0) return token;
  }

  // 2. Fallback: cookie (backup pour environnements non-iframe)
  const cookieToken = request.cookies.get('access_token')?.value ?? null;
  return cookieToken;
}
