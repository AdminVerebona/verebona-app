/**
 * GET /api/auth/oauth/{google|apple}/start — lot 93, CDC 18 §7.2, §12.2,
 * §21.3, §29 : crée la transaction serveur (state, nonce, PKCE, contexte,
 * 10 min, usage unique) et redirige vers le fournisseur.
 *
 * Paramètres (filtrés, conservés côté serveur) : intent=login|signup,
 * returnUrl (chemin interne), inviteToken, transmissionToken, ref ;
 * link_pending=1 (« J'ai déjà un compte » prouvé par CE fournisseur déjà lié) ;
 * client=app&app_challenge=<S256> (application mobile, retour par
 * APP_OAUTH_RETURN_URL). Fournisseur inactif : 404.
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  contextFromQuery, errorPath, notFound, oauthRateLimited, pendingLinkContext, providerConfigOr404, redirectTo, startFlow,
} from '@/lib/auth/oauth/flow';
import { setBindingCookie } from '@/lib/auth/oauth/transactions';

export async function GET(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const cfg = providerConfigOr404((await context.params).provider);
  if (!cfg) return notFound();
  const q = request.nextUrl.searchParams;
  const intent = q.get('intent') === 'signup' ? 'signup' : 'login';
  if (await oauthRateLimited(request, 'start')) return redirectTo(errorPath(intent, 'RATE_LIMIT_EXCEEDED'));
  const ctx = contextFromQuery(q);
  if ('error' in ctx) return NextResponse.json({ error: ctx.error, code: ctx.error }, { status: 400 });
  if (q.get('link_pending') === '1') {
    const pendingId = await pendingLinkContext(request, cfg.provider);
    if (pendingId) ctx.pendingLinkTxId = pendingId;
  }
  try {
    const flow = await startFlow({ request, cfg, intent, context: ctx });
    const res = NextResponse.redirect(flow.url, 302);
    setBindingCookie(res, flow.binding);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (e) {
    console.error('[oauth] démarrage impossible :', (e as Error)?.message ?? e);
    return redirectTo(errorPath(intent, 'OAUTH_PROVIDER_ERROR', ctx));
  }
}
