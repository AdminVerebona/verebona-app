import { NextRequest, NextResponse } from 'next/server';
import { getSession, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { apiError } from '@/lib/api-errors';
import { mobilePlatformOf, readClientContext } from '@/lib/mobile/client-context';
import { isMobileFeatureEnabled } from '@/lib/mobile/mobile-config';
import { rateLimiter } from '@/lib/rate-limiter';
import { issueShareImportGrant, listActiveShareImportGrants, revokeShareImportGrants } from '@/services/mobile/share-import/grants';

export const dynamic = 'force-dynamic';

/**
 * POST /api/mobile/share-import/grant — lot 110A (partage natif).
 *
 * Émet le JETON D'IMPORT de la session appelante, que l'application ouverte
 * remet à sa partie native (extension de partage iOS, envoi de fond
 * Android). Derrière la GARDE DE SESSION habituelle (`getSession` :
 * révocations, accès actif à l'espace, CGUV ; garde MFA du lot 110B quand
 * elle y sera branchée). AUCUNE session n'est émise : le jeton ne permet que
 * `POST /api/mobile/share-import/upload` (import seul) dans l'espace courant.
 *
 * Réponse : { token, expiresAt, maxUses, accountKey, uploadPath }. Le jeton
 * n'est rendu qu'ici, une fois ; seule son empreinte est conservée.
 */
/**
 * Lot 111P — trace technique EXPURGÉE (journal Scalingo) : code stable,
 * plateforme, identifiants internes ; jamais le jeton, un cookie, un nom de
 * fichier ni une adresse.
 */
function trace(event: string, d: Record<string, string | number | null>): void {
  console.info(JSON.stringify({ event: `share_import.${event}`, ...d }));
}

/** Code d'un refus de la garde de session (MFA_REQUIRED, AUTH_REQUIRED…), pour la trace. */
function sessionErrorCode(e: unknown): string {
  const m = (e as Error)?.message ?? '';
  return /^[A-Z_]{3,40}$/.test(m) ? m : 'SESSION_ERROR';
}

export async function POST(request: NextRequest) {
  const ctx = readClientContext(request);
  const platform = mobilePlatformOf(ctx.client);
  let session;
  try { session = await getSession(request); } catch (e) {
    if (isSessionError(e)) {
      trace('grant_refused', { code: sessionErrorCode(e), platform });
      return sessionErrorResponse(e);
    }
    throw e;
  }
  if (!session.currentAccountId) {
    trace('grant_refused', { code: 'ACCOUNT_NOT_FOUND', platform, userId: session.userId });
    return apiError(409, 'ACCOUNT_NOT_FOUND', 'Aucun espace sélectionné.');
  }
  if (!platform) return apiError(400, 'UNSUPPORTED', 'Réservé à l’application mobile Verebona.');
  if (!isMobileFeatureEnabled('share_in', platform)) {
    trace('grant_refused', { code: 'FEATURE_OFF', platform, userId: session.userId });
    return apiError(503, 'UNSUPPORTED', 'Partage vers Verebona momentanément suspendu.');
  }
  const limit = rateLimiter.check(`share-import-grant:${session.userId}`);
  if (!limit.allowed) {
    trace('grant_refused', { code: 'RATE_LIMIT_EXCEEDED', platform, userId: session.userId });
    return apiError(429, 'RATE_LIMIT_EXCEEDED', 'Trop de demandes, réessayez dans une minute.');
  }

  const grant = await issueShareImportGrant({
    userId: session.userId, accountId: session.currentAccountId, sid: session.sid ?? null, platform, installationId: ctx.installationId,
    sessionAal: session.aal === 2 ? 2 : 1,
  });
  trace('grant_issued', { platform, userId: session.userId, accountId: session.currentAccountId, aal: session.aal === 2 ? 2 : 1 });
  return NextResponse.json(
    { ...grant, uploadPath: '/api/mobile/share-import/upload' },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * GET /api/mobile/share-import/grant — lot 111P : vérification LÉGÈRE de la
 * validité côté serveur, derrière la même garde de session. Rend les
 * références NON SECRÈTES des jetons encore actifs de la session appelante
 * dans l'espace courant ({ grants: [{ ref, expiresAt, usesLeft }] }) ; jamais
 * un jeton. Aucun usage n'est consommé.
 */
export async function GET(request: NextRequest) {
  let session;
  try { session = await getSession(request); } catch (e) {
    if (isSessionError(e)) return sessionErrorResponse(e);
    throw e;
  }
  if (!session.currentAccountId) return apiError(409, 'ACCOUNT_NOT_FOUND', 'Aucun espace sélectionné.');
  const ctx = readClientContext(request);
  if (!mobilePlatformOf(ctx.client)) return apiError(400, 'UNSUPPORTED', 'Réservé à l’application mobile Verebona.');
  const grants = await listActiveShareImportGrants({
    userId: session.userId, accountId: session.currentAccountId, sid: session.sid ?? null, installationId: ctx.installationId,
  });
  return NextResponse.json({ grants }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * DELETE /api/mobile/share-import/grant — révoque les jetons d'import de la
 * session appelante (déconnexion, changement d'espace). Idempotent.
 */
export async function DELETE(request: NextRequest) {
  let session;
  try { session = await getSession(request); } catch (e) {
    if (isSessionError(e)) return sessionErrorResponse(e);
    throw e;
  }
  const ctx = readClientContext(request);
  const revoked = await revokeShareImportGrants({ userId: session.userId, sid: session.sid ?? null, installationId: ctx.installationId }, 'CLIENT_REVOKED');
  return NextResponse.json({ ok: true, revoked }, { headers: { 'Cache-Control': 'no-store' } });
}
