/**
 * Ouvrir le Centre d'aide depuis l'application — CDC §1.1, GAP-09, MOB-01.
 *
 * · Sur ordinateur : l'article s'ouvre sur le site public, dans un nouvel
 *   onglet isolé (§1.1 « raccourcis vers les articles publics »).
 * · Sur mobile (petit écran ou application installée) : dans le Centre d'aide
 *   intégré de l'application (`/aide`), avec « Retour à Verebona », sans
 *   quitter l'application (MOB-01, MOB-03).
 */
import { publicSiteUrl } from '@/lib/external-urls';
import { safeInternalPath } from '@/lib/safe-redirect';

export const EMBED_QUERY = 'integre=app';

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

export function helpPageUrl(path: string, embedded: boolean): string {
  const safe = isHelpPath(path) ? path : '/aide';
  if (!embedded) return publicSiteUrl(safe);
  return publicSiteUrl(`${safe}${safe.includes('?') ? '&' : '?'}${EMBED_QUERY}`);
}

/**
 * Page de l'application où revenir : chemin interne, jamais `/aide` lui-même
 * ni une adresse d'un autre site (`//hôte`).
 */
export function safeReturnPath(raw: string | null | undefined): string {
  // Même règle « chemin interne » que les pages d'authentification
  // (`safe-redirect.ts`) : une seule implémentation à tenir juste.
  const path = safeInternalPath(raw, '/accueil');
  return /^\/aide(\/|\?|$)/.test(path) ? '/accueil' : path;
}

/**
 * Route interne du Centre d'aide intégré.
 *
 * `returnTo` : où « Retour à Verebona » ramène. Fixé à l'ouverture, parce que
 * l'historique du navigateur ne suffit pas : il contient aussi les pages lues
 * DANS le cadre, et reculer d'un pas ramènerait à l'article précédent.
 */
export function integratedHelpHref(path: string, returnTo?: string): string {
  const safe = isHelpPath(path) ? path : '/aide';
  const params = new URLSearchParams();
  if (safe !== '/aide') params.set('page', safe);
  if (returnTo) params.set('retour', safeReturnPath(returnTo));
  const q = params.toString();
  return q ? `/aide?${q}` : '/aide';
}

export function prefersIntegratedHelp(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(max-width: 767px)').matches
    || window.matchMedia('(display-mode: standalone)').matches;
}

/**
 * Lot 59, point 3 — le Centre d'aide s'ouvre TOUJOURS dans un nouvel onglet
 * du navigateur, sur le site public, jamais dans l'application (ordinateur
 * ET mobile ; dans l'application installée, l'adresse externe part dans le
 * navigateur du téléphone). Le Centre d'aide intégré (`/aide`) reste
 * joignable par son adresse (anciens liens, réponses enregistrées), mais
 * plus aucune entrée de l'application n'y mène.
 */
export function openHelpCenter(path: string = '/aide'): void {
  if (typeof window === 'undefined') return;
  window.open(helpPageUrl(path, false), '_blank', 'noopener,noreferrer');
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
