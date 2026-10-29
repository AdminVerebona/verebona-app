/**
 * GET /api/auth/oauth/app/continue?ticket=… — lot 97B (PO M1 ; CDC 18 §12.2,
 * §12.3, §18.2, §21.3).
 *
 * Ouvert dans le NAVIGATEUR SYSTÈME par l'application (ASWebAuthenticationSession
 * sur iOS, Custom Tabs sur Android) pour « Associer » ou « Confirmer avec »
 * Google / Apple depuis Mon compte › Sécurité. Le ticket (usage unique,
 * 10 min) a été créé par la vue de l'app, authentifiée et réauthentifiée.
 * Ici : liaison de CE navigateur (cookie `vb_oauth`), puis redirection vers le
 * fournisseur. Ticket inconnu, déjà utilisé ou expiré : retour à l'app avec
 * une erreur (`APP_OAUTH_RETURN_URL?error=OAUTH_STATE_INVALID`).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { continueAppTicket, notFound, oauthRateLimited } from '@/lib/auth/oauth/flow';
import { enabledProviders } from '@/lib/auth/oauth/config';

export async function GET(request: NextRequest) {
  const e = enabledProviders();
  if (!e.google && !e.apple) return notFound();
  if (await oauthRateLimited(request, 'start')) {
    return NextResponse.json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.', code: 'RATE_LIMIT_EXCEEDED' }, { status: 429 });
  }
  return continueAppTicket(request, request.nextUrl.searchParams.get('ticket'));
}
