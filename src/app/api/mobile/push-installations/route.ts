import { NextRequest, NextResponse } from 'next/server';
import { getSession, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { apiError } from '@/lib/api-errors';
import { mobilePlatformOf, parseAppVersion, parseInstallationId, readClientContext, type MobilePlatform } from '@/lib/mobile/client-context';
import { isMobileFeatureEnabled } from '@/lib/mobile/mobile-config';
import { getMobilePushProvider } from '@/lib/mobile/push-provider';
import { isValidPushToken, listInstallations, registerPushInstallation } from '@/lib/mobile/push-installations';

export const dynamic = 'force-dynamic';

/**
 * POST /api/mobile/push-installations — lot 97 (CDC 12 §18 PUSH-01, PUSH-09,
 * §18.1, Annexe A).
 *
 * Enregistre (ou met à jour) l'installation de l'application mobile courante
 * et son jeton push. Authentifiée (session de l'utilisateur), IDEMPOTENTE :
 * l'app l'appelle à chaque démarrage, après connexion et à chaque rotation
 * du jeton ; rejouer l'appel ne crée rien de plus.
 *
 * Corps : { installationId, platform: 'ios'|'android', pushToken,
 *           appVersion?, build? } — `installationId`, `platform` et
 * `appVersion` peuvent aussi venir des en-têtes X-Verebona-* ; s'ils sont
 * présents des deux côtés, ils doivent concorder.
 *
 * Réponse : { ok, installation: { id, status }, created, pushEnabled,
 *             providerConfigured }. Le jeton n'est jamais renvoyé.
 */
export async function POST(request: NextRequest) {
  let session;
  try { session = await getSession(request); } catch (e) {
    if (isSessionError(e)) return sessionErrorResponse(e);
    throw e;
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return apiError(400, 'INVALID_INPUT', 'Corps JSON attendu.');
  const ctx = readClientContext(request);

  const fromBody = body.installationId === undefined ? null : parseInstallationId(body.installationId);
  if (body.installationId !== undefined && !fromBody) return apiError(400, 'INVALID_FORMAT', 'Identifiant d’installation invalide.', { field: 'installationId' });
  if (fromBody && ctx.installationId && fromBody !== ctx.installationId) {
    return apiError(400, 'INVALID_INPUT', 'Identifiant d’installation différent de l’en-tête X-Verebona-Installation-Id.', { field: 'installationId' });
  }
  const installationId = fromBody ?? ctx.installationId;
  if (!installationId) return apiError(400, 'MISSING_FIELD', 'Identifiant d’installation requis.', { field: 'installationId' });

  const headerPlatform = mobilePlatformOf(ctx.client);
  const bodyPlatform = body.platform === 'ios' || body.platform === 'android' ? body.platform as MobilePlatform : null;
  if (body.platform !== undefined && !bodyPlatform) return apiError(400, 'INVALID_FORMAT', 'Plateforme attendue : ios ou android.', { field: 'platform' });
  if (bodyPlatform && headerPlatform && bodyPlatform !== headerPlatform) {
    return apiError(400, 'INVALID_INPUT', 'Plateforme différente de l’en-tête X-Verebona-Client.', { field: 'platform' });
  }
  const platform = bodyPlatform ?? headerPlatform;
  if (!platform) return apiError(400, 'MISSING_FIELD', 'Plateforme requise (ios ou android).', { field: 'platform' });

  if (!isValidPushToken(body.pushToken)) return apiError(400, 'INVALID_FORMAT', 'Jeton push invalide.', { field: 'pushToken' });

  const versionBody = body.appVersion === undefined || body.appVersion === null ? null : parseAppVersion(String(body.appVersion));
  if (body.appVersion !== undefined && body.appVersion !== null && !versionBody) {
    return apiError(400, 'INVALID_FORMAT', 'Version d’application invalide.', { field: 'appVersion' });
  }
  const buildBody = typeof body.build === 'string' || typeof body.build === 'number' ? String(body.build).trim() : null;
  if (buildBody !== null && !/^\d{1,9}$/.test(buildBody)) return apiError(400, 'INVALID_FORMAT', 'Numéro de build invalide.', { field: 'build' });

  try {
    const r = await registerPushInstallation({
      userId: session.userId,
      accountId: session.currentAccountId ?? null,
      // Famille de session (`sid`) déjà vérifiée par `getSession` (borne de révocation comprise).
      sessionId: session.sid ?? null,
      installationId,
      platform,
      appVersion: versionBody?.version ?? ctx.appVersion,
      build: buildBody ?? versionBody?.build ?? ctx.build,
      pushToken: body.pushToken,
    });
    console.info('[mobile-push] installation enregistrée', {
      userId: session.userId, installation: `${installationId.slice(0, 8)}…`, platform,
      created: r.created, reassigned: r.reassigned, revokedDuplicates: r.revokedDuplicates,
    });
    return NextResponse.json({
      ok: true,
      installation: { id: r.id, status: 'active' },
      created: r.created,
      pushEnabled: isMobileFeatureEnabled('push', platform),
      providerConfigured: !!getMobilePushProvider(),
    }, { status: r.created ? 201 : 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[mobile-push] enregistrement impossible :', (e as Error).message);
    return apiError(500, 'INTERNAL_ERROR', 'Enregistrement de l’appareil impossible pour le moment.');
  }
}

/**
 * GET /api/mobile/push-installations — appareils mobiles de l'utilisateur
 * (liste minimisée : plateforme, version, statut, dernières activités ;
 * jamais de jeton). Socle de l'écran « Mes appareils » (hors V1, ACC-12).
 */
export async function GET(request: NextRequest) {
  let session;
  try { session = await getSession(request); } catch (e) {
    if (isSessionError(e)) return sessionErrorResponse(e);
    throw e;
  }
  const devices = await listInstallations(session.userId, readClientContext(request).installationId);
  return NextResponse.json({ devices }, { headers: { 'Cache-Control': 'no-store' } });
}
