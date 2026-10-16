/**
 * /aide… — redirection vers le Centre d'aide PUBLIC (lot 63B).
 *
 * Le Centre d'aide intégré (`(dashboard)/aide`, cadre du site public) est
 * supprimé : plus aucun bouton n'y mène depuis le lot 59 (ouverture en nouvel
 * onglet, `lib/help-center/open.ts`). Restent les anciens liens — favoris,
 * e-mails, réponses enregistrées de l'assistant (`/aide?page=/aide/<slug>`),
 * liens `/aide/<slug>` — redirigés vers la page publique correspondante.
 *
 * Même règle que le clic dans l'application (`helpPathFromAppHref`,
 * `helpPageUrl`) : seuls des chemins d'aide sûrs, jamais une adresse
 * arbitraire ; à défaut, l'accueil du Centre d'aide. Sans session (lien
 * public) ; redirection temporaire (307) pour ne pas figer l'adresse du site
 * public dans les navigateurs.
 */
import { NextRequest, NextResponse } from 'next/server';
import { helpRedirectTarget } from '@/lib/help-center/open';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest): NextResponse {
  return NextResponse.redirect(helpRedirectTarget(req.nextUrl.pathname, req.nextUrl.search), 307);
}

export const HEAD = GET;
