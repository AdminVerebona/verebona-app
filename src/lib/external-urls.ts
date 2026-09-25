/**
 * URLs des applications Verebona externes (cross-repo).
 *
 * app.verebona.fr (ce repo)  <->  verebona.fr (vitrine, repo verebona-public)
 *
 * Les URLs viennent de variables d'environnement NEXT_PUBLIC_* (injectees au
 * build), jamais codees en dur, pour rester correctes par environnement
 * (local / preprod / prod).
 */

// URL du site vitrine (repo verebona-public). Fallback = prod.
//
// ⚠️ Avec `www.` : c'est l'origine canonique du site, et l'apex y est
// redirigé. Le Centre d'aide en dépend — cadre de /aide (CSP, message
// « Retour à Verebona »), lecture du catalogue (CORS), retours d'articles
// (CSRF) comparent l'origine EXACTE. Une variable réglée sur l'apex les
// casserait tous derrière la redirection.
export const PUBLIC_SITE_URL =
  process.env.NEXT_PUBLIC_PUBLIC_SITE_URL ?? "https://www.verebona.fr";

/** Construit une URL absolue vers le site vitrine. */
export function publicSiteUrl(path: string = "/"): string {
  const base = PUBLIC_SITE_URL.replace(/\/+$/, ""); // retire slash final
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}
