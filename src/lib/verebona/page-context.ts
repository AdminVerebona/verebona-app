/**
 * Contexte de page transmis au champ Verebona — Direction D v2 §5.
 *
 * Le même champ figure sur toutes les pages et appelle exactement la même
 * fonction, avec le contexte de la page courante. Le layout ne transmet que
 * des informations lisibles dans l'adresse ; `enrichPageContext` en extrait
 * ensuite le bien, le document ou le fournisseur ouverts, et le serveur
 * revalide chaque identifiant.
 */

/** Rubrique de l'application, pour les suggestions et le serveur. */
export type PageArea =
  | 'home' | 'assets' | 'asset' | 'agenda' | 'documents' | 'document' | 'to_process'
  | 'suppliers' | 'supplier' | 'account' | 'help' | 'other';

const AREAS: Array<[RegExp, PageArea]> = [
  [/^\/accueil\/a-traiter(\/|$)/, 'to_process'],
  [/^\/dashboard\/a-traiter(\/|$)/, 'to_process'],
  [/^\/accueil\/?$/, 'home'],
  [/^\/assets\/\d+(\/|$)/, 'asset'],
  [/^\/assets\/?$/, 'assets'],
  [/^\/agenda(\/|$)/, 'agenda'],
  [/^\/documents\/\d+(\/|$)/, 'document'],
  [/^\/documents(\/|$)/, 'documents'],
  [/^\/fournisseurs\/\d+(\/|$)/, 'supplier'],
  [/^\/fournisseurs(\/|$)/, 'suppliers'],
  [/^\/mon-compte(\/|$)/, 'account'],
  [/^\/aide(\/|$)/, 'help'],
];

export function pageAreaOf(pathname: string | null | undefined): PageArea {
  const route = (pathname ?? '/').split(/[?#]/)[0];
  for (const [re, area] of AREAS) if (re.test(route)) return area;
  return 'other';
}

/**
 * Contexte envoyé avec chaque demande : la route (le serveur en déduit « ce
 * bien », « ce document »…) et la rubrique. Jamais de donnée métier : le
 * serveur relit tout lui-même.
 */
export function buildPageContext(pathname: string | null | undefined): Record<string, string> {
  const route = (pathname ?? '/').split(/[?#]/)[0] || '/';
  return { route, area: pageAreaOf(route) };
}
