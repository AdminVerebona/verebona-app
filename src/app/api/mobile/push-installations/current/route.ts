import { NextRequest, NextResponse } from 'next/server';
import { getSession, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { apiError } from '@/lib/api-errors';
import { parseInstallationId, readClientContext } from '@/lib/mobile/client-context';
import { unregisterPushInstallation } from '@/lib/mobile/push-installations';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/mobile/push-installations/current — lot 97 (CDC 12 AUTH-10,
 * PUSH-08, REC-010 / REC-040).
 *
 * Désinscrit l'appareil courant (identifié par `installationId` dans le
 * corps ou par l'en-tête X-Verebona-Installation-Id) : à appeler par l'app
 * AVANT la déconnexion, ou quand l'utilisateur coupe les notifications dans
 * l'app. Plus aucun push n'arrive sur cet appareil ; les autres appareils de
 * l'utilisateur ne sont pas touchés. Idempotente (`removed: false` si déjà
 * désinscrit ou inconnu — jamais d'information sur l'appareil d'un autre).
 *
 * Filet côté serveur : la révocation de la session désactive aussi le push
 * de l'appareil (`deactivatePushForSession`, branchée sur le registre des
 * sessions).
 */
export async function DELETE(request: NextRequest) {
  let session;
  try { session = await getSession(request); } catch (e) {
    if (isSessionError(e)) return sessionErrorResponse(e);
    throw e;
  }
  const body = await request.json().catch(() => null) as { installationId?: unknown } | null;
  const installationId = (body?.installationId !== undefined ? parseInstallationId(body.installationId) : null)
    ?? readClientContext(request).installationId;
  if (!installationId) return apiError(400, 'MISSING_FIELD', 'Identifiant d’installation requis.', { field: 'installationId' });
  const removed = await unregisterPushInstallation(session.userId, installationId);
  return NextResponse.json({ ok: true, removed }, { headers: { 'Cache-Control': 'no-store' } });
}
