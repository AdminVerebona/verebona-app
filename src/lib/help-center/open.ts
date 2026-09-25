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

export const EMBED_QUERY = 'integre=app';

/** Chemin d'aide sûr : `/aide`, `/aide/<slug>`, `/aide/theme/<slug>`, avec `?q=` éventuel. */
export function isHelpPath(path: string): boolean {
  return /^\/aide(\/(theme\/)?[a-z0-9-]+)?(\?q=[^#]*)?$/.test(path);
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
  if (!raw || !/^\/(?!\/)[^\s\\]*$/.test(raw) || /^\/aide(\/|\?|$)/.test(raw)) return '/accueil';
  return raw;
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
