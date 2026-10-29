/**
 * Retour du fournisseur — lot 93, CDC 18 §12.2, §29, §37.
 *
 *   GET  /api/auth/oauth/{google|apple}/callback  Google (code en paramètre),
 *        ou reprise Apple après form_post (state seul) ;
 *   POST /api/auth/oauth/apple/callback           Apple `response_mode=form_post`
 *        (requête inter-sites : exemptée du contrôle d'origine CSRF, protégée
 *        par state + nonce + PKCE + liaison au navigateur vérifiée au GET).
 *
 * Fournisseur inactif : 404. Retour rejoué ou expiré : refus, aucune session.
 */
import type { NextRequest } from 'next/server';
import {
  errorPath, handleCallback, handleFormPost, notFound, oauthRateLimited, providerConfigOr404, redirectTo,
} from '@/lib/auth/oauth/flow';

export async function GET(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const cfg = providerConfigOr404((await context.params).provider);
  if (!cfg) return notFound();
  if (await oauthRateLimited(request, 'callback')) return redirectTo(errorPath('login', 'RATE_LIMIT_EXCEEDED'));
  const q = request.nextUrl.searchParams;
  try {
    return await handleCallback(request, cfg, { state: q.get('state'), code: q.get('code'), error: q.get('error') });
  } catch (e) {
    console.error('[oauth] retour du fournisseur :', (e as Error)?.message ?? e);
    return redirectTo(errorPath('login', 'OAUTH_PROVIDER_ERROR'));
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const cfg = providerConfigOr404((await context.params).provider);
  if (!cfg || cfg.provider !== 'apple') return notFound();
  if (await oauthRateLimited(request, 'callback')) return redirectTo(errorPath('login', 'RATE_LIMIT_EXCEEDED'), 303);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirectTo(errorPath('login', 'OAUTH_STATE_INVALID'), 303);
  }
  const s = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' ? v : null;
  };
  try {
    return await handleFormPost(request, cfg, { state: s('state'), code: s('code'), error: s('error'), appleUser: s('user') });
  } catch (e) {
    console.error('[oauth] retour Apple :', (e as Error)?.message ?? e);
    return redirectTo(errorPath('login', 'OAUTH_PROVIDER_ERROR'), 303);
  }
}
