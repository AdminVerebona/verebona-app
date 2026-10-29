/**
 * POST /api/users/me/auth-identities/{google|apple}/link — lot 93, CDC 18
 * §12.3, §18.2, §29 : démarre le rattachement d'un fournisseur au compte
 * CONNECTÉ, après réauthentification fraîche par une méthode DÉJÀ liée
 * (jamais la nouvelle). Rend { redirectUrl } : l'écran y navigue. Au retour,
 * l'identité est liée à CE compte et à CETTE session seulement ; une identité
 * déjà liée ailleurs est refusée (§8.3). Fournisseur inactif : 404.
 * Preuve : réauthentification du lot 92 (`requireReauth`, action
 * `link-provider`) ; corps facultatif { currentPassword } (clients anciens).
 * Lot 97B : corps { client: 'app', appChallenge } depuis l'application →
 * { redirectUrl } à ouvrir dans le NAVIGATEUR SYSTÈME (jamais la WebView).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getProviderConfig, isOAuthProvider } from '@/lib/auth/oauth/config';
import { requireReauth } from '@/lib/auth/oauth/account-security';
import { listIdentities } from '@/lib/auth/oauth/identities';
import { appAccountContextFromBody, appContextErrorResponse, oauthRateLimited, startAppAccountFlow, startFlow } from '@/lib/auth/oauth/flow';
import { setBindingCookie } from '@/lib/auth/oauth/transactions';
import { SOCIAL_ERROR_MESSAGES } from '@/lib/auth/oauth/messages';
import { rateLimitBody } from '@/lib/auth/auth-rate-limit';

export async function POST(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const provider = (await context.params).provider;
  const cfg = isOAuthProvider(provider) ? getProviderConfig(provider) : null;
  if (!cfg) return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  // Session ET preuve de réauthentification 92 de cette session.
  const reauth = await requireReauth(request, body, 'link-provider');
  if (!reauth.ok) return reauth.response;
  const { userId, sid } = reauth;
  if ((await listIdentities(userId)).some((i) => i.provider === cfg.provider)) {
    const m = SOCIAL_ERROR_MESSAGES.PROVIDER_ALREADY_LINKED;
    return NextResponse.json({ error: m, code: 'PROVIDER_ALREADY_LINKED', message: m }, { status: 409 });
  }
  if (await oauthRateLimited(request, 'start')) return NextResponse.json(rateLimitBody(900), { status: 429 });
  // Lot 97B (PO M1) : depuis l'application, le parcours s'ouvre dans le
  // navigateur système (ticket à usage unique) ; l'association est appliquée
  // à l'échange, dans la vue de l'app (`/api/auth/oauth/app/exchange`).
  const app = appAccountContextFromBody(body);
  if (app && 'error' in app) return appContextErrorResponse(app.error);
  if (app) {
    const started = await startAppAccountFlow({ request, cfg, intent: 'link', context: app, userId, sessionSid: sid });
    return NextResponse.json({ redirectUrl: started.redirectUrl });
  }
  const flow = await startFlow({ request, cfg, intent: 'link', context: { client: 'web' }, userId, sessionSid: sid });
  const res = NextResponse.json({ redirectUrl: flow.url });
  setBindingCookie(res, flow.binding);
  return res;
}
