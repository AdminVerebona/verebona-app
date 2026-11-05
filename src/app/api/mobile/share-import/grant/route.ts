import { NextRequest, NextResponse } from 'next/server';
import { getSession, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { apiError } from '@/lib/api-errors';
import { mobilePlatformOf, readClientContext } from '@/lib/mobile/client-context';
import { isMobileFeatureEnabled } from '@/lib/mobile/mobile-config';
import { rateLimiter } from '@/lib/rate-limiter';
import { issueShareImportGrant, revokeShareImportGrants } from '@/services/mobile/share-import/grants';

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
export async function POST(request: NextRequest) {
  let session;
  try { session = await getSession(request); } catch (e) {
    if (isSessionError(e)) return sessionErrorResponse(e);
    throw e;
  }
  if (!session.currentAccountId) return apiError(409, 'ACCOUNT_NOT_FOUND', 'Aucun espace sélectionné.');
  const ctx = readClientContext(request);
  const platform = mobilePlatformOf(ctx.client);
  if (!platform) return apiError(400, 'UNSUPPORTED', 'Réservé à l’application mobile Verebona.');
  if (!isMobileFeatureEnabled('share_in', platform)) return apiError(503, 'UNSUPPORTED', 'Partage vers Verebona momentanément suspendu.');
  const limit = rateLimiter.check(`share-import-grant:${session.userId}`);
  if (!limit.allowed) return apiError(429, 'RATE_LIMIT_EXCEEDED', 'Trop de demandes, réessayez dans une minute.');

  const grant = await issueShareImportGrant({
    userId: session.userId, accountId: session.currentAccountId, sid: session.sid ?? null, platform, installationId: ctx.installationId,
    sessionAal: session.aal === 2 ? 2 : 1,
  });
  return NextResponse.json(
    { ...grant, uploadPath: '/api/mobile/share-import/upload' },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
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
