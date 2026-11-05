/**
 * Réponses et gardes communes des routes MFA (lot 110B).
 *
 *   · `withPending(request, fn)` : routes `/api/auth/mfa/*` — exige le
 *     contexte PROVISOIRE valide (`pending.ts`) ; jamais une session
 *     complète, jamais un accès métier ;
 *   · `withStrongSession(request, fn)` : routes `/api/users/me/security/mfa/*`
 *     — session complète (SessionService : révocation, statut, garde MFA).
 * Toutes les réponses : `Cache-Control: no-store`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { SessionService, type SessionPayload } from '@/lib/session-service';
import { readPending, type PendingContext } from './pending';
import { MFA_MESSAGES } from './constants';
import { MfaKeyUnavailableError } from './secret-box';
import { WebAuthnUnavailableError } from './passkeys';

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function mfaJson(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function mfaError(status: number, code: string, message: string): NextResponse {
  return mfaJson({ error: code, code, message }, status);
}

export const expiredResponse = () => mfaError(401, 'MFA_EXPIRED', MFA_MESSAGES.expired);

/** Erreurs de configuration (clé de chiffrement, origines WebAuthn) : 503 explicite, sans détail. */
export function mfaUnavailable(error: unknown, what: 'totp' | 'passkey'): NextResponse | null {
  if (error instanceof MfaKeyUnavailableError || error instanceof WebAuthnUnavailableError) {
    console.error(`[mfa] méthode indisponible : configuration incomplète (${(error as Error).name}).`);
    void what;
    return mfaError(503, 'MFA_METHOD_UNAVAILABLE', error instanceof WebAuthnUnavailableError
      ? 'Les clés d’accès ne sont pas disponibles pour le moment. Utilisez l’application d’authentification.'
      : 'L’application d’authentification n’est pas disponible pour le moment. Réessayez plus tard.');
  }
  return null;
}

export async function withPending(
  request: NextRequest,
  fn: (ctx: PendingContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  let ctx: PendingContext | null;
  try {
    ctx = await readPending(request);
  } catch (e) {
    console.error('[mfa] lecture du contexte provisoire impossible :', (e as Error)?.message ?? e);
    return mfaError(503, 'SERVICE_UNAVAILABLE', 'Service momentanément indisponible. Réessayez.');
  }
  if (!ctx) return expiredResponse();
  try {
    return await fn(ctx);
  } catch (e) {
    const u = mfaUnavailable(e, 'passkey') ?? null;
    if (u) return u;
    console.error('[mfa] étape provisoire en échec :', (e as Error)?.message ?? e);
    return mfaError(500, 'MFA_FAILED', 'Une erreur est survenue. Réessayez.');
  }
}

export async function withSession(
  request: NextRequest,
  fn: (session: SessionPayload & { sid: string }) => Promise<NextResponse>,
): Promise<NextResponse> {
  let session: SessionPayload;
  try {
    session = await SessionService.getSession(request);
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
  if (!session.sid) return mfaError(401, 'SESSION_REVOKED', 'Votre session doit être renouvelée : reconnectez-vous.');
  try {
    return await fn(session as SessionPayload & { sid: string });
  } catch (e) {
    const u = mfaUnavailable(e, 'passkey');
    if (u) return u;
    console.error('[mfa] opération de sécurité en échec :', (e as Error)?.message ?? e);
    return mfaError(500, 'MFA_FAILED', 'Une erreur est survenue. Réessayez.');
  }
}

/** Corps JSON (tolérant) — objet vide si absent ou invalide. */
export async function bodyOf(request: NextRequest): Promise<Record<string, unknown>> {
  const b = await request.json().catch(() => ({}));
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {};
}
