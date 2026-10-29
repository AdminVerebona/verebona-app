/**
 * Lot 96A (CDC 18 Q9) — activation d'un compte dans les scénarios E2E.
 *
 * Le lien reçu par e-mail n'active plus rien seul : `GET
 * /api/auth/verify-email?token=` mène à la page « Activez votre compte »,
 * qui envoie `POST /api/auth/verify-email { token, password }`. Cet assistant
 * rejoue les deux étapes comme le navigateur et rend une réponse au format
 * de l'ancien GET (redirection `location` + cookies de session), pour que
 * les scénarios existants gardent leurs assertions.
 *
 *   · lien mort (invalide, expiré, déjà utilisé, ancien format) : la réponse
 *     du GET telle quelle (redirection vers `/verify-email?error=…`) ;
 *   · lien valable : redirection vers `redirectTo` rendu par le POST, cookies
 *     du POST ; échec du POST : `/verify-email/activer?refus=<code>`.
 */
import { NextRequest, NextResponse } from 'next/server';

export async function activerParLien(url: string, password: string, opts: { ip?: string } = {}): Promise<NextResponse> {
  const { GET, POST } = await import('@/app/api/auth/verify-email/route');
  const g = await GET(new NextRequest(url));
  const loc = g.headers.get('location') ?? '';
  const target = new URL(loc, url);
  if (target.pathname !== '/verify-email/activer') return g;
  const origin = new URL(url).origin;
  const res = await POST(new NextRequest(`${origin}/api/auth/verify-email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', origin,
      'x-forwarded-for': opts.ip ?? `96.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.1`,
    },
    body: JSON.stringify({ token: target.searchParams.get('token'), password, plan: target.searchParams.get('plan') ?? undefined }),
  }));
  const body = (await res.json().catch(() => ({}))) as { redirectTo?: string; code?: string };
  const base = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  const out = NextResponse.redirect(`${base}${body.redirectTo ?? `/verify-email/activer?refus=${body.code ?? res.status}`}`);
  for (const c of res.cookies.getAll()) out.cookies.set(c);
  return out;
}
