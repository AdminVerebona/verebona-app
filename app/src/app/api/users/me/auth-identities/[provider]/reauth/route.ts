/**
 * POST /api/users/me/auth-identities/{google|apple}/reauth — lot 93, CDC 18
 * §18.2 (« Réauthentification Google / Apple et vérification du même subject
 * lié »), §29 (« OAuth reauth via flow dédié ») : démarre la
 * réauthentification par un fournisseur DÉJÀ lié à ce compte. Au retour, la
 * preuve de 5 minutes du lot 92 (`issueReauthProof`) est émise pour CETTE
 * session (`flow.ts › completeReauth`), puis l'écran Sécurité reprend l'action
 * demandée (`resume`). Rend { redirectUrl }.
 * Lot 97B : corps { client: 'app', appChallenge, resume } depuis l'application
 * → adresse à ouvrir dans le NAVIGATEUR SYSTÈME (jamais la WebView).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { getProviderConfig, isOAuthProvider } from '@/lib/auth/oauth/config';
import { listIdentities } from '@/lib/auth/oauth/identities';
import { appAccountContextFromBody, appContextErrorResponse, oauthRateLimited, startAppAccountFlow, startFlow } from '@/lib/auth/oauth/flow';
import { setBindingCookie } from '@/lib/auth/oauth/transactions';
import { rateLimitBody } from '@/lib/auth/auth-rate-limit';

// Lot 96A : 'change-email' (Mon compte › Sécurité › Adresse e-mail, Q8).
// Lot 101C : 'revoke-others' rouvre seulement le sous-bloc « Appareils connectés » (aucune action rejouée).
const RESUMABLE = new Set(['add-password', 'link-google', 'link-apple', 'unlink-google', 'unlink-apple', 'delete-account', 'change-password', 'change-email', 'revoke-others']);

export async function POST(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  let userId: number;
  let sid: string | undefined;
  try {
    ({ userId, sid } = await SessionService.getSession(request));
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
  const provider = (await context.params).provider;
  const cfg = isOAuthProvider(provider) ? getProviderConfig(provider) : null;
  if (!cfg) return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });
  if (!(await listIdentities(userId)).some((i) => i.provider === cfg.provider)) {
    return NextResponse.json({ error: 'Ce fournisseur n’est pas associé à votre compte.', code: 'NOT_LINKED' }, { status: 409 });
  }
  if (await oauthRateLimited(request, 'start')) return NextResponse.json(rateLimitBody(900), { status: 429 });
  const body = (await request.json().catch(() => ({}))) as { resume?: unknown } & Record<string, unknown>;
  const resume = typeof body.resume === 'string' && RESUMABLE.has(body.resume) ? body.resume : undefined;
  // Lot 97B (PO M1) : depuis l'application → navigateur système ; la preuve
  // de 5 min est émise pour CETTE session à l'échange, dans la vue de l'app.
  const app = appAccountContextFromBody(body);
  if (app && 'error' in app) return appContextErrorResponse(app.error);
  if (app) {
    const started = await startAppAccountFlow({
      request, cfg, intent: 'reauth', context: { ...app, ...(resume ? { resume } : {}) }, userId, sessionSid: sid ?? null,
    });
    return NextResponse.json({ redirectUrl: started.redirectUrl });
  }
  const flow = await startFlow({
    request, cfg, intent: 'reauth', context: { client: 'web', ...(resume ? { resume } : {}) }, userId, sessionSid: sid ?? null,
  });
  const res = NextResponse.json({ redirectUrl: flow.url });
  setBindingCookie(res, flow.binding);
  return res;
}
