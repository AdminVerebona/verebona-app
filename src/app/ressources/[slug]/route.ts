/**
 * `/ressources/<slug>` dans l'application — lot 108J.
 *
 * L'assistant cite un article Ressources par son chemin public
 * (`/ressources/<slug>`, posé par le serveur depuis le corpus, jamais par le
 * modèle). Un clic est intercepté (`openResourceFromLink` : nouvel onglet sur
 * le site public) ; une navigation directe (réponse enregistrée, lien copié)
 * est redirigée ici vers l'article public. Jamais une adresse arbitraire,
 * jamais vers le Centre d'aide.
 */
import { NextRequest, NextResponse } from 'next/server';
import { resourcePageUrl } from '@/lib/help-center/open';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest): NextResponse {
  return NextResponse.redirect(resourcePageUrl(req.nextUrl.pathname.toLowerCase()), 307);
}

export const HEAD = GET;
