/**
 * Ouvrir le Centre d'aide depuis l'application — CDC §1.1, GAP-09, MOB-01.
 *
 * Depuis le lot 59 (point 3), le Centre d'aide s'ouvre TOUJOURS sur le site
 * public, dans un nouvel onglet du navigateur (ordinateur ET mobile). Le
 * Centre d'aide intégré de l'application (page `/aide` en cadre) a été
 * supprimé au lot 63B : `/aide…` n'est plus qu'une REDIRECTION vers la page
 * publique correspondante (`src/app/aide/[[...slug]]/route.ts`), pour les
 * anciens liens, favoris, e-mails et réponses enregistrées de l'assistant.
 */
import { publicSiteUrl } from '@/lib/external-urls';

/**
 * Formulaire de contact du site public — CDC Centre d'aide §5 (« si le corpus
 * ne permet pas de répondre, renvoyer vers le formulaire de contact »).
 */
export const HELP_CONTACT_PATH = '/contact';

/**
 * Chemin d'aide sûr : `/aide`, `/aide/<slug>`, `/aide/theme/<slug>`, avec
 * `?q=` éventuel, ou le formulaire de contact `/contact` (renvoi au support
 * depuis l'assistant).
 */
export function isHelpPath(path: string): boolean {
  return /^\/aide(\/(theme\/)?[a-z0-9-]+)?(\?q=[^#]*)?$/.test(path) || path === HELP_CONTACT_PATH;
}

/** Adresse publique d'une page d'aide sûre (`/aide` à défaut). */
export function helpPageUrl(path: string): string {
  return publicSiteUrl(isHelpPath(path) ? path : '/aide');
}

/**
 * Lien interne vers une page d'aide, tel que l'assistant l'écrit dans ses
 * réponses (format historique, conservé : réponses enregistrées) :
 * `/aide?page=<chemin>`. Un clic est intercepté (`openHelpFromLink`) ; une
 * navigation directe passe par la redirection `/aide` → site public.
 */
export function integratedHelpHref(path: string): string {
  const safe = isHelpPath(path) ? path : '/aide';
  return safe === '/aide' ? '/aide' : `/aide?${new URLSearchParams({ page: safe }).toString()}`;
}

/**
 * Lot 59, point 3 — le Centre d'aide s'ouvre TOUJOURS dans un nouvel onglet
 * du navigateur, sur le site public, jamais dans l'application (ordinateur
 * ET mobile ; dans l'application installée, l'adresse externe part dans le
 * navigateur du téléphone).
 */
export function openHelpCenter(path: string = '/aide'): void {
  if (typeof window === 'undefined') return;
  window.open(helpPageUrl(path), '_blank', 'noopener,noreferrer');
}

/**
 * Page du Centre d'aide désignée par un lien interne de l'application
 * (`/aide`, `/aide?page=/aide/<slug>`, `/aide/<slug>` — réponses de
 * l'assistant), ou `null` si le lien ne mène pas au Centre d'aide.
 */
export function helpPathFromAppHref(href: string | null | undefined): string | null {
  if (!href || !href.startsWith('/aide')) return null;
  const [path, query = ''] = href.split('#')[0].split('?');
  if (path !== '/aide') return isHelpPath(href.split('#')[0]) ? href.split('#')[0] : null;
  const params = new URLSearchParams(query);
  const page = params.get('page');
  if (page) return isHelpPath(page) ? page : '/aide';
  const q = params.get('q');
  return q ? `/aide?q=${encodeURIComponent(q)}` : '/aide';
}

/**
 * Clic sur un lien interne vers le Centre d'aide : ouvert dans un nouvel
 * onglet (site public), sans navigation dans l'application. Rend `true` si
 * le clic est traité.
 */
export function openHelpFromLink(
  e: { preventDefault(): void } | null | undefined,
  href: string | null | undefined,
): boolean {
  const path = helpPathFromAppHref(href);
  if (!path) return false;
  e?.preventDefault();
  openHelpCenter(path);
  return true;
}

/**
 * Destination publique d'une adresse `/aide…` de l'application (lot 63B,
 * redirection `src/app/aide/[[...slug]]/route.ts`) : la page d'aide désignée,
 * sinon l'accueil du Centre d'aide. Jamais une adresse arbitraire.
 */
export function helpRedirectTarget(pathname: string, search: string = ''): string {
  return helpPageUrl(helpPathFromAppHref(`${pathname}${search}`) ?? '/aide');
}
